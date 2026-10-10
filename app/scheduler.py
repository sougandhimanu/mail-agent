import asyncio
import traceback

from . import db, gmail

POLL_SECONDS = 15


def _send_one(row: dict):
    try:
        message_id = gmail.send(row["to_addr"], row["subject"], row["body"])
        db.mark_sent(row["id"], message_id)
        print(f"sent email #{row['id']} to {row['to_addr']}", flush=True)
    except Exception as e:  # noqa: BLE001 - we want to retry on anything
        traceback.print_exc()
        db.mark_retry_or_failed(row["id"], row["attempts"], f"{type(e).__name__}: {e}")


async def run_forever():
    """Poll the DB and send anything that is due. Survives restarts because state lives in SQLite."""
    db.recover_stuck()
    tick = 0
    while True:
        try:
            for row in db.claim_due():
                # Gmail client is blocking; run in a thread so the web server stays responsive.
                await asyncio.to_thread(_send_one, row)
            tick += 1
            if tick % 40 == 0:  # ~every 10 minutes
                db.recover_stuck()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        await asyncio.sleep(POLL_SECONDS)
