import base64
import os
from email.message import EmailMessage

SCOPES = ["https://www.googleapis.com/auth/gmail.send"]


def is_configured() -> bool:
    return all(
        os.environ.get(k)
        for k in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN")
    )


def _service():
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    creds = Credentials(
        token=None,
        refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
        client_id=os.environ["GOOGLE_CLIENT_ID"],
        client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
        token_uri="https://oauth2.googleapis.com/token",
        scopes=SCOPES,
    )
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def send(to_addr: str, subject: str, body: str) -> str:
    """Send an email from the authorized Gmail account. Returns the Gmail message id.

    With DRY_RUN=1 (or no Gmail credentials) nothing is sent; the message is logged instead.
    """
    if os.environ.get("DRY_RUN") == "1" or not is_configured():
        print(f"[DRY RUN] would send to={to_addr!r} subject={subject!r}", flush=True)
        return "dry-run"

    msg = EmailMessage()
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg.set_content(body)
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    result = _service().users().messages().send(userId="me", body={"raw": raw}).execute()
    return result["id"]
