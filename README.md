# Mail Scheduler Agent

Chat in plain English with Claude ("email jane@example.com at 5 PM, 9 PM and 3 PM tomorrow...").
It schedules the emails; a background scheduler on a cloud server sends them through the Gmail API,
so you can close your computer.

```
browser chat page -> POST /chat -> Claude (tools: schedule/list/cancel)
                                        |
                                     SQLite  <- scheduler loop (every 15s) -> Gmail API
```

## What you need to provide (I can't do these for you)

1. **Anthropic API key** from https://console.anthropic.com
2. **Google OAuth client** (one-time, ~5 min):
   - Google Cloud Console -> create project -> enable **Gmail API**
   - OAuth consent screen: External, add yourself as a **test user**
   - Credentials -> Create OAuth client ID -> **Desktop app** -> download JSON
   - On your computer: `pip install google-auth-oauthlib && python scripts/get_gmail_token.py client_secret.json`
   - It prints `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`
   - Note: while the consent screen is in "Testing", Google expires refresh tokens after 7 days.
     Click "Publish app" (fine for personal use) to avoid that.
3. **A cloud host.** Fly.io config is included (any Docker host works, but it needs a persistent
   disk and must never sleep).

## Deploy on Fly.io

```bash
fly launch --no-deploy --copy-config      # pick a unique app name
fly volumes create mail_data --size 1
fly secrets set ANTHROPIC_API_KEY=... APP_PASSWORD=<long random string> \
  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=...
fly deploy
```

Open `https://<app>.fly.dev`, enter your `APP_PASSWORD`, and start scheduling.
`/health` shows whether Gmail credentials are configured.

## Run locally

```bash
pip install -r requirements.txt
cp .env.example .env   # fill in, then: set -a; source .env; set +a
DRY_RUN=1 uvicorn app.main:app --port 8080     # DRY_RUN logs instead of sending
```

## Behavior notes

- Times are interpreted in `USER_TIMEZONE` (default America/Chicago).
- Failed sends retry with backoff (1, 2, 4 min) then are marked `failed`; ask the agent to list them.
- Jobs live in SQLite on the mounted volume, so restarts and redeploys don't lose them.
- Run exactly one instance/worker (the scheduler loop is in-process).
- Anyone with `APP_PASSWORD` can send mail as you. Keep it long and secret.
- Gmail may limit sending for new/low-trust accounts (about 500 recipients/day for normal accounts).
