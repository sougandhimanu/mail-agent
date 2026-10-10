# Mail Scheduler Agent

Chat in plain English with Claude ("email jane@example.com at 12 PM, 2 PM and 3 PM today…").
Claude schedules the emails, and a scheduler in the cloud sends them from your Gmail at the right
time, even when your computer is off.

There are two ways to run it:

| | Where it runs | Sends with your laptop off? | Guide |
|---|---|---|---|
| **Cloud (main)** | Supabase (database, Edge Functions, cron) + a static chat page | Yes | [SUPABASE.md](SUPABASE.md) |
| **Local** | Python app on your own computer | No, only while it's running | [Run locally](#run-locally) |

The two don't share data: each has its own database of scheduled emails.

## How it works (cloud)

```
Chat page (docs/)  ->  Edge Function "chat"  ->  Claude (tools: schedule / list / cancel)
                                                       |
                                              Supabase Postgres
                                                       |
pg_cron (every minute)  ->  Edge Function "send-due"  ->  Gmail API
GitHub Actions (daily)  ->  health check, so the free Supabase project doesn't pause
```

## Project layout

| Path | What it is |
|---|---|
| `supabase/functions/chat/` | Cloud chat endpoint: password check, Claude conversation, Outbox list |
| `supabase/functions/send-due/` | Cloud sender, called every minute by `pg_cron` |
| `supabase/functions/_shared/` | Helpers shared by both functions |
| `supabase/migrations/` | Database tables, permissions and the every-minute cron job |
| `docs/` | Chat page for the cloud version (`config.js` holds the Supabase functions URL) |
| `.github/workflows/keepalive.yml` | Daily ping that keeps the free Supabase project awake |
| `app/` | Local Python app (FastAPI server, Claude agent, SQLite, Gmail sender, 15-second scheduler) |
| `static/` | Chat page for the local app |
| `scripts/get_gmail_token.py` | One-time Google sign-in that prints the Gmail credentials |

## Credentials you need

1. **Anthropic API key** from https://console.anthropic.com (add credits and set a spend limit).
2. **Google OAuth client** (one-time, ~5 min):
   - Google Cloud Console -> create a project -> enable the **Gmail API**.
   - Google Auth Platform: audience **External**, add yourself as a **test user**.
   - Clients -> create an OAuth client of type **Desktop app** -> download the JSON as `client_secret.json`.
   - Run `pip install google-auth-oauthlib` and `python scripts/get_gmail_token.py client_secret.json`.
     It prints `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN`.
   - While the app is in "Testing", Google expires the refresh token after 7 days. Click
     **Publish app** (fine for personal use) and run the script again to get a lasting token.
3. **`APP_PASSWORD`**: a long random string that protects the chat, e.g.
   `python -c "import secrets; print(secrets.token_urlsafe(32))"`.

Copy `.env.example` to `.env` and fill these in. `.env`, `client_secret.json` and
`supabase/secrets.env` are git-ignored; never commit them.

## Deploy to the cloud

Follow [SUPABASE.md](SUPABASE.md): create a free Supabase project, apply the migration, set the
function secrets, deploy the two functions, add the two Vault secrets for the cron job, and point
`docs/config.js` at your project. Then open `docs/index.html` (or host the `docs/` folder on any
static host) and enter your `APP_PASSWORD`.

## Run locally

```bash
pip install -r requirements.txt
python -m uvicorn app.main:app --env-file .env --port 8080
```

Open http://localhost:8080 and enter your `APP_PASSWORD`. Set `DRY_RUN=1` in `.env` to log emails
instead of sending them. Emails only go out while this process is running.

## Behavior notes

- Times are interpreted in `USER_TIMEZONE` (default America/Chicago).
- Failed sends retry after 1, 2 and 4 minutes, then are marked `failed`. The Outbox panel shows
  each email's status and any error.
- The Outbox reads the database directly and doesn't use Claude credit; each chat message does
  (roughly 1-3 cents).
- Anyone with `APP_PASSWORD` can send mail as you. Keep it long and secret.
- Gmail limits normal accounts to about 500 recipients a day.
