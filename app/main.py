import asyncio
import hmac
import os
from contextlib import asynccontextmanager

try:
    # Use the OS certificate store so HTTPS works behind antivirus TLS scanning (e.g. Avast).
    import truststore

    truststore.inject_into_ssl()
except ImportError:
    pass

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import agent, db, gmail, scheduler

APP_PASSWORD = os.environ.get("APP_PASSWORD", "")


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init()
    task = asyncio.create_task(scheduler.run_forever())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan)


def require_auth(authorization: str = Header(default="")):
    # This service can send email as you, so it must never run open.
    if not APP_PASSWORD:
        raise HTTPException(503, "APP_PASSWORD is not set on the server")
    token = authorization.removeprefix("Bearer ").strip()
    if not hmac.compare_digest(token, APP_PASSWORD):
        raise HTTPException(401, "Unauthorized")


class ChatIn(BaseModel):
    session_id: str = "default"
    message: str


@app.get("/")
def index():
    return FileResponse("static/index.html")


@app.get("/health")
def health():
    return {"ok": True, "gmail_configured": gmail.is_configured(), "dry_run": os.environ.get("DRY_RUN") == "1"}


@app.post("/chat", dependencies=[Depends(require_auth)])
async def chat(body: ChatIn):
    reply = await asyncio.to_thread(agent.chat, body.session_id, body.message)
    return {"reply": reply}


@app.get("/scheduled", dependencies=[Depends(require_auth)])
def scheduled():
    return db.list_emails()
