import json
import os
from datetime import datetime
from zoneinfo import ZoneInfo

import anthropic

from . import db

MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-5-5")
TZ = ZoneInfo(os.environ.get("USER_TIMEZONE", "America/Chicago"))
MAX_HISTORY = 30

client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY

TOOLS = [
    {
        "name": "schedule_email",
        "description": (
            "Schedule one email to be sent from the user's Gmail account at a specific future time. "
            "Call once per email. For 'send one at 5 PM, 9 PM and 3 PM' call it three times."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "to": {"type": "string", "description": "Recipient email address"},
                "subject": {"type": "string"},
                "body": {"type": "string", "description": "Plain-text email body"},
                "send_at": {
                    "type": "string",
                    "description": "ISO 8601 timestamp WITH UTC offset, e.g. 2026-10-09T17:00:00-05:00",
                },
            },
            "required": ["to", "subject", "body", "send_at"],
        },
    },
    {
        "name": "list_scheduled",
        "description": "List emails that are scheduled (pending) or recently sent/failed/cancelled.",
        "input_schema": {
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["pending", "sent", "failed", "cancelled"],
                    "description": "Optional filter",
                }
            },
        },
    },
    {
        "name": "cancel_scheduled",
        "description": "Cancel a pending scheduled email by its id.",
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "integer"}},
            "required": ["id"],
        },
    },
]


def _system_prompt() -> str:
    now = datetime.now(TZ)
    return (
        "You are an email scheduling assistant connected to the user's Gmail. "
        "You schedule, list and cancel emails using your tools; a background scheduler in the cloud "
        "sends them at the right time even if the user's computer is off.\n\n"
        f"Current date/time: {now.strftime('%A, %Y-%m-%d %H:%M')} ({TZ.key}, UTC offset {now.strftime('%z')}).\n"
        "Interpret all times in that timezone unless the user says otherwise. Bare times like '5 PM' mean "
        "the next occurrence of that time (today if still in the future, otherwise tomorrow) unless a day is given. "
        "Always pass send_at as ISO 8601 with the correct UTC offset.\n\n"
        "Rules: if the recipient address is missing, ask for it. If subject/body are not specified, write "
        "something short and sensible from context rather than asking. Never schedule a time in the past. "
        "After scheduling, confirm briefly with each email's id, recipient and send time in the user's timezone."
    )


def _run_tool(name: str, args: dict) -> str:
    try:
        if name == "schedule_email":
            send_at = datetime.fromisoformat(args["send_at"])
            if send_at.tzinfo is None:
                send_at = send_at.replace(tzinfo=TZ)
            if send_at <= datetime.now(TZ):
                return json.dumps({"error": "send_at is in the past; pick a future time."})
            if "@" not in args["to"]:
                return json.dumps({"error": "invalid recipient address"})
            email_id = db.add(args["to"], args["subject"], args["body"], send_at)
            return json.dumps(
                {"ok": True, "id": email_id, "send_at_local": send_at.astimezone(TZ).strftime("%a %b %d, %I:%M %p %Z")}
            )
        if name == "list_scheduled":
            rows = db.list_emails(args.get("status"))
            return json.dumps(
                [
                    {
                        "id": r["id"],
                        "to": r["to_addr"],
                        "subject": r["subject"],
                        "status": r["status"],
                        "send_at_local": datetime.fromisoformat(r["send_at"]).astimezone(TZ).strftime("%a %b %d, %I:%M %p %Z"),
                        "error": r["error"],
                    }
                    for r in rows
                ]
            )
        if name == "cancel_scheduled":
            return json.dumps({"cancelled": db.cancel(int(args["id"]))})
        return json.dumps({"error": f"unknown tool {name}"})
    except Exception as e:  # noqa: BLE001
        return json.dumps({"error": f"{type(e).__name__}: {e}"})


_sessions: dict[str, list] = {}


def chat(session_id: str, user_message: str) -> str:
    history = _sessions.setdefault(session_id, [])
    history.append({"role": "user", "content": user_message})

    for _ in range(10):  # tool-use loop
        resp = client.messages.create(
            model=MODEL,
            max_tokens=1500,
            system=_system_prompt(),
            tools=TOOLS,
            messages=history,
        )
        history.append({"role": "assistant", "content": [b.model_dump() for b in resp.content]})

        if resp.stop_reason != "tool_use":
            text = "".join(b.text for b in resp.content if b.type == "text")
            del history[:-MAX_HISTORY]
            return text

        results = [
            {"type": "tool_result", "tool_use_id": b.id, "content": _run_tool(b.name, b.input)}
            for b in resp.content
            if b.type == "tool_use"
        ]
        history.append({"role": "user", "content": results})

    return "Sorry, I got stuck handling that. Please try rephrasing."
