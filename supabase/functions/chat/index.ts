import Anthropic from "npm:@anthropic-ai/sdk";
import { corsHeaders, db, formatLocal, gmailConfigured, hasBearer, json, TZ } from "../_shared/common.ts";

const MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-5-5";
// When a session grows past this, the next turn starts a fresh conversation.
// (History is never trimmed mid-conversation: the API rejects edited history. The
// scheduled emails live in the database, so nothing is lost by starting over.)
const MAX_HISTORY = 40;

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

const TOOLS = [
  {
    name: "schedule_email",
    description:
      "Schedule one email to be sent from the user's Gmail account at a specific future time. " +
      "Call once per email. For 'send one at 5 PM, 9 PM and 3 PM' call it three times.",
    input_schema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text email body" },
        send_at: {
          type: "string",
          description: "ISO 8601 timestamp WITH UTC offset, e.g. 2026-10-09T17:00:00-05:00",
        },
      },
      required: ["to", "subject", "body", "send_at"],
    },
  },
  {
    name: "list_scheduled",
    description: "List emails that are scheduled (pending) or recently sent/failed/cancelled.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["pending", "sent", "failed", "cancelled"],
          description: "Optional filter",
        },
      },
    },
  },
  {
    name: "cancel_scheduled",
    description: "Cancel a pending scheduled email by its id.",
    input_schema: {
      type: "object" as const,
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
  },
];

// Fixed for the whole conversation. The current time goes into each user turn instead,
// so the system prompt never changes between requests.
const SYSTEM =
  "You are an email scheduling assistant connected to the user's Gmail. " +
  "You schedule, list and cancel emails using your tools; a scheduler in the cloud sends them " +
  "at the right time even if the user's computer is off.\n\n" +
  `The user's timezone is ${TZ}. Each user message starts with the current date/time in brackets. ` +
  "Interpret all times in the user's timezone unless they say otherwise. Bare times like '5 PM' mean " +
  "the next occurrence of that time (today if still in the future, otherwise tomorrow) unless a day is given. " +
  "Always pass send_at as ISO 8601 with the correct UTC offset for that date.\n\n" +
  "Rules: if the recipient address is missing, ask for it. If subject/body are not specified, write " +
  "something short and sensible from context rather than asking. Never schedule a time in the past. " +
  "After scheduling, confirm briefly with each email's id, recipient and send time in the user's timezone.";

function nowStamp(): string {
  const now = new Date();
  const local = now.toLocaleString("en-US", {
    timeZone: TZ,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "longOffset",
  });
  return `[Current date/time: ${local} (${TZ})]`;
}

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    if (name === "schedule_email") {
      const sendAtRaw = String(args.send_at ?? "");
      if (!/(Z|[+-]\d{2}:?\d{2})$/.test(sendAtRaw)) {
        return JSON.stringify({ error: "send_at must include a UTC offset, e.g. 2026-10-09T17:00:00-05:00" });
      }
      const sendAt = new Date(sendAtRaw);
      if (isNaN(sendAt.getTime())) return JSON.stringify({ error: "send_at is not a valid ISO 8601 timestamp" });
      if (sendAt.getTime() <= Date.now()) return JSON.stringify({ error: "send_at is in the past; pick a future time." });
      const to = String(args.to ?? "").trim();
      if (!to.includes("@")) return JSON.stringify({ error: "invalid recipient address" });

      const { data, error } = await db
        .from("scheduled_emails")
        .insert({ to_addr: to, subject: String(args.subject ?? ""), body: String(args.body ?? ""), send_at: sendAt.toISOString() })
        .select("id")
        .single();
      if (error) throw error;
      return JSON.stringify({ ok: true, id: data.id, send_at_local: formatLocal(sendAt) });
    }

    if (name === "list_scheduled") {
      let q = db.from("scheduled_emails").select("id,to_addr,subject,status,send_at,error");
      if (args.status) q = q.eq("status", String(args.status));
      const { data, error } = await q.order("send_at", { ascending: true }).limit(50);
      if (error) throw error;
      return JSON.stringify(
        data.map((r) => ({
          id: r.id,
          to: r.to_addr,
          subject: r.subject,
          status: r.status,
          send_at_local: formatLocal(new Date(r.send_at)),
          error: r.error,
        })),
      );
    }

    if (name === "cancel_scheduled") {
      const { data, error } = await db
        .from("scheduled_emails")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", Number(args.id))
        .eq("status", "pending")
        .select("id");
      if (error) throw error;
      return JSON.stringify({ cancelled: data.length > 0 });
    }

    return JSON.stringify({ error: `unknown tool ${name}` });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  }
}

async function chat(sessionId: string, userMessage: string): Promise<string> {
  const { data: row } = await db.from("chat_sessions").select("messages").eq("id", sessionId).maybeSingle();
  // deno-lint-ignore no-explicit-any
  let history: any[] = row?.messages ?? [];
  if (history.length > MAX_HISTORY) history = [];

  const save = () =>
    db.from("chat_sessions").upsert({ id: sessionId, messages: history, updated_at: new Date().toISOString() });

  // Append-only from here on: earlier turns are sent back exactly as they were.
  history.push({ role: "user", content: `${nowStamp()}\n\n${userMessage}` });

  for (let i = 0; i < 10; i++) { // tool-use loop
    const resp = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      tools: TOOLS,
      messages: history,
      output_config: { effort: "medium" },
      // Server-side refusal fallback (Claude API only): re-runs a declined request on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    // deno-lint-ignore no-explicit-any
    } as any);
    history.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason === "refusal") {
      await save();
      return "Sorry, I can't help with that request.";
    }
    if (resp.stop_reason !== "tool_use") {
      await save();
      // deno-lint-ignore no-explicit-any
      return resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    }

    const results = [];
    for (const b of resp.content) {
      if (b.type === "tool_use") {
        results.push({ type: "tool_result", tool_use_id: b.id, content: await runTool(b.name, b.input as Record<string, unknown>) });
      }
    }
    history.push({ role: "user", content: results });
  }

  await save();
  return "Sorry, I got stuck handling that. Please try rephrasing.";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (req.method === "GET" && new URL(req.url).searchParams.has("list")) {
    // The page's Outbox panel: same rows as the Python app's /scheduled, password required.
    if (!hasBearer(req, Deno.env.get("APP_PASSWORD"))) return json({ error: "Unauthorized" }, 401);
    const { data, error } = await db
      .from("scheduled_emails")
      .select("id,to_addr,subject,status,send_at,error,gmail_message_id")
      .order("send_at", { ascending: true })
      .limit(50);
    if (error) return json({ error: error.message }, 500);
    return json(data);
  }

  if (req.method === "GET") {
    // Health check; also touches the database so the free project counts as active.
    const { error } = await db.from("scheduled_emails").select("id", { head: true, count: "exact" });
    return json({ ok: !error, gmail_configured: gmailConfigured(), dry_run: Deno.env.get("DRY_RUN") === "1" });
  }

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  // This service can send email as you, so it must never run open.
  if (!Deno.env.get("APP_PASSWORD")) return json({ error: "APP_PASSWORD is not set on the server" }, 503);
  if (!hasBearer(req, Deno.env.get("APP_PASSWORD"))) return json({ error: "Unauthorized" }, 401);

  let body: { session_id?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const message = (body.message ?? "").trim();
  if (!message) return json({ error: "message is required" }, 400);
  const sessionId = (body.session_id ?? "default").slice(0, 100);

  try {
    return json({ reply: await chat(sessionId, message) });
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
