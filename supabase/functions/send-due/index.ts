// Called every minute by pg_cron. Sends every pending email whose time has come.
import { db, gmailConfigured, hasBearer, json } from "../_shared/common.ts";

const MAX_ATTEMPTS = 4;

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Google token refresh failed: ${data.error ?? r.status} ${data.error_description ?? ""}`);
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const utf8 = (s: string) => new TextEncoder().encode(s);
// Strip CR/LF so a recipient or subject can't inject extra headers.
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

function buildMime(to: string, subject: string, body: string): string {
  const mime = [
    `To: ${oneLine(to)}`,
    `Subject: =?UTF-8?B?${b64(utf8(oneLine(subject)))}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(utf8(body)).replace(/.{76}/g, "$&\r\n"),
  ].join("\r\n");
  return b64(utf8(mime)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Send from the authorized Gmail account. Returns the Gmail message id. */
async function sendGmail(to: string, subject: string, body: string): Promise<string> {
  if (Deno.env.get("DRY_RUN") === "1" || !gmailConfigured()) {
    console.log(`[DRY RUN] would send to=${JSON.stringify(to)} subject=${JSON.stringify(subject)}`);
    return "dry-run";
  }
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: buildMime(to, subject, body) }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Gmail send failed (${r.status}): ${data.error?.message ?? JSON.stringify(data)}`);
  return data.id;
}

Deno.serve(async (req) => {
  if (!hasBearer(req, Deno.env.get("CRON_SECRET"))) return json({ error: "Unauthorized" }, 401);

  await db.rpc("recover_stuck");
  const { data: due, error } = await db.rpc("claim_due", { max_rows: 20 });
  if (error) {
    console.error(error);
    return json({ error: error.message }, 500);
  }

  let sent = 0, retried = 0, failed = 0;
  for (const row of due ?? []) {
    try {
      const messageId = await sendGmail(row.to_addr, row.subject, row.body);
      await db.from("scheduled_emails")
        .update({ status: "sent", gmail_message_id: messageId, error: null, updated_at: new Date().toISOString() })
        .eq("id", row.id);
      console.log(`sent email #${row.id} to ${row.to_addr}`);
      sent++;
    } catch (e) {
      const msg = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 500);
      console.error(`email #${row.id}: ${msg}`);
      if (row.attempts >= MAX_ATTEMPTS) {
        await db.from("scheduled_emails")
          .update({ status: "failed", error: msg, updated_at: new Date().toISOString() })
          .eq("id", row.id);
        failed++;
      } else {
        // back off: 1, 2, 4 minutes
        const retryAt = new Date(Date.now() + 2 ** (row.attempts - 1) * 60_000);
        await db.from("scheduled_emails")
          .update({ status: "pending", send_at: retryAt.toISOString(), error: msg, updated_at: new Date().toISOString() })
          .eq("id", row.id);
        retried++;
      }
    }
  }
  return json({ claimed: due?.length ?? 0, sent, retried, failed });
});
