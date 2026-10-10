import os
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

DB_PATH = os.environ.get("DB_PATH", "data/mail_agent.db")
_lock = threading.Lock()


def _conn():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    return c


def init():
    with _lock, _conn() as c:
        c.execute(
            """CREATE TABLE IF NOT EXISTS scheduled_emails (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                to_addr TEXT NOT NULL,
                subject TEXT NOT NULL,
                body TEXT NOT NULL,
                send_at TEXT NOT NULL,            -- UTC ISO 8601
                status TEXT NOT NULL DEFAULT 'pending',  -- pending|sending|sent|failed|cancelled
                attempts INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                gmail_message_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"""
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_due ON scheduled_emails(status, send_at)")


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def add(to_addr, subject, body, send_at: datetime) -> int:
    now = _iso(_now())
    with _lock, _conn() as c:
        cur = c.execute(
            "INSERT INTO scheduled_emails (to_addr, subject, body, send_at, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (to_addr, subject, body, _iso(send_at), now, now),
        )
        return cur.lastrowid


def list_emails(status=None, limit=50):
    q = "SELECT * FROM scheduled_emails"
    args = []
    if status:
        q += " WHERE status = ?"
        args.append(status)
    q += " ORDER BY send_at ASC LIMIT ?"
    args.append(limit)
    with _lock, _conn() as c:
        return [dict(r) for r in c.execute(q, args)]


def cancel(email_id: int) -> bool:
    with _lock, _conn() as c:
        cur = c.execute(
            "UPDATE scheduled_emails SET status='cancelled', updated_at=? WHERE id=? AND status='pending'",
            (_iso(_now()), email_id),
        )
        return cur.rowcount > 0


def claim_due(limit=20):
    """Atomically move due pending emails to 'sending' and return them."""
    now = _iso(_now())
    with _lock, _conn() as c:
        rows = c.execute(
            "SELECT * FROM scheduled_emails WHERE status='pending' AND send_at <= ? "
            "ORDER BY send_at ASC LIMIT ?",
            (now, limit),
        ).fetchall()
        claimed = []
        for r in rows:
            cur = c.execute(
                "UPDATE scheduled_emails SET status='sending', attempts=attempts+1, updated_at=? "
                "WHERE id=? AND status='pending'",
                (now, r["id"]),
            )
            if cur.rowcount:
                claimed.append(dict(r) | {"attempts": r["attempts"] + 1})
        return claimed


def mark_sent(email_id, message_id):
    with _lock, _conn() as c:
        c.execute(
            "UPDATE scheduled_emails SET status='sent', gmail_message_id=?, error=NULL, updated_at=? WHERE id=?",
            (message_id, _iso(_now()), email_id),
        )


def mark_retry_or_failed(email_id, attempts, error, max_attempts=4):
    now = _now()
    with _lock, _conn() as c:
        if attempts >= max_attempts:
            c.execute(
                "UPDATE scheduled_emails SET status='failed', error=?, updated_at=? WHERE id=?",
                (error[:500], _iso(now), email_id),
            )
        else:
            # back off: 1, 2, 4 minutes
            retry_at = now + timedelta(minutes=2 ** (attempts - 1))
            c.execute(
                "UPDATE scheduled_emails SET status='pending', send_at=?, error=?, updated_at=? WHERE id=?",
                (_iso(retry_at), error[:500], _iso(now), email_id),
            )


def recover_stuck(minutes=10):
    """If the server died mid-send, put 'sending' rows back to pending."""
    cutoff = _iso(_now() - timedelta(minutes=minutes))
    with _lock, _conn() as c:
        c.execute(
            "UPDATE scheduled_emails SET status='pending', updated_at=? WHERE status='sending' AND updated_at < ?",
            (_iso(_now()), cutoff),
        )
