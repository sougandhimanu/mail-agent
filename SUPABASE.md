# Free cloud hosting: Supabase + GitHub Pages

Runs the Mail Scheduler Agent with your laptop off, at $0.

```
Chat page (GitHub Pages)  ->  Edge Function "chat"  ->  Claude (schedule / list / cancel tools)
                                                              |
                                                     Supabase Postgres
                                                              |
pg_cron (every minute)  ->  Edge Function "send-due"  ->  Gmail API
GitHub Actions (daily)  ->  health check, so the free project never pauses
```

| Python app | Supabase version |
|---|---|
| `app/agent.py` | `supabase/functions/chat/index.ts` |
| `app/scheduler.py` + `app/gmail.py` | `supabase/functions/send-due/index.ts` |
| `app/db.py` (SQLite) | `supabase/migrations/20261009000000_init.sql` (Postgres) |
| `static/index.html` | `docs/index.html` + `docs/config.js` |

Emails go out within about a minute of their scheduled time. Failed sends retry after 1, 2 and 4 minutes, then are marked `failed`.

## 1. Create the Supabase project

1. Sign up at https://supabase.com (free) and create a project in a US region. Save the database password.
2. Note the **Project URL** (Project Settings -> API), e.g. `https://abcd1234.supabase.co`. The part before `.supabase.co` is the project ref.

## 2. Deploy the backend (from this folder)

```powershell
npx supabase login
npx supabase link --project-ref <project-ref>        # asks for the database password
npx supabase db push                                   # creates tables, functions and the cron job
npx supabase secrets set --env-file supabase/secrets.env
npx supabase functions deploy chat
npx supabase functions deploy send-due
```

Before `secrets set`, copy `supabase/secrets.env.example` to `supabase/secrets.env` (git-ignored) and fill it in.
Generate `APP_PASSWORD` and `CRON_SECRET` with `python -c "import secrets; print(secrets.token_urlsafe(32))"`.

If `link` fails with a privileges error (fine-grained access tokens without "API Key Secrets"), skip `link`/`db push`:
paste `supabase/migrations/20261009000000_init.sql` into the dashboard's **SQL Editor** and run it, then add
`--project-ref <project-ref>` to the `secrets set` and `functions deploy` commands.

Then, in the dashboard's **SQL Editor**, give the cron job its URL and secret (stored encrypted in Vault):

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<same CRON_SECRET as above>', 'cron_secret');
```

Check: open `https://<project-ref>.supabase.co/functions/v1/chat` in a browser; it should show `"ok":true,"gmail_configured":true`.

## 3. Publish the chat page (GitHub Pages)

1. Set the URL in `docs/config.js`: `https://<project-ref>.supabase.co/functions/v1`.
2. Push this folder to a GitHub repo. **Never commit `.env`, `client_secret.json` or `supabase/secrets.env`** (`.gitignore` blocks them).
3. Repo -> Settings -> Pages -> Source: *Deploy from a branch*, branch `main`, folder `/docs`.
4. Open `https://<user>.github.io/<repo>/`, enter `APP_PASSWORD`, and start scheduling.

## 4. Keep the free project awake

Repo -> Settings -> Secrets and variables -> Actions -> **Variables** -> add `SUPABASE_FUNCTIONS_URL` = `https://<project-ref>.supabase.co/functions/v1`.
The `Keep Supabase awake` workflow then pings the health check daily (run it once by hand from the Actions tab to test).

## Checking on emails

- Ask in the chat: "list my sent emails".
- Supabase dashboard -> Table Editor -> `scheduled_emails` (status, attempts, error).
- Supabase dashboard -> Edge Functions -> `send-due` -> Logs (`sent email #N to ...`).
- Gmail -> Sent.

## Notes

- Anyone with `APP_PASSWORD` can send mail as you. Keep it long and secret; change it with `npx supabase secrets set APP_PASSWORD=...`.
- The Gmail refresh token expires after 7 days while the Google consent screen is in "Testing". Publish the app, re-run `scripts/get_gmail_token.py`, then update `GOOGLE_REFRESH_TOKEN`.
- Chat history is append-only (Claude's API rejects edited history on newer accounts). After 40 messages a session starts fresh; scheduled emails are unaffected because they live in the database.
- Set `DRY_RUN=1` to log instead of sending.
