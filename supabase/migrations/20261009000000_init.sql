-- Mail Scheduler Agent: database, sending queue, and the every-minute cron job.

create table if not exists public.scheduled_emails (
  id bigint generated always as identity primary key,
  to_addr text not null,
  subject text not null,
  body text not null,
  send_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempts int not null default 0,
  error text,
  gmail_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_due on public.scheduled_emails (status, send_at);

-- Chat history per browser session (Edge Functions are stateless).
create table if not exists public.chat_sessions (
  id text primary key,
  messages jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- RLS on with no policies: only the Edge Functions (service role) can read or write.
alter table public.scheduled_emails enable row level security;
alter table public.chat_sessions enable row level security;

-- Atomically move due pending emails to 'sending' and return them.
create or replace function public.claim_due(max_rows int default 20)
returns setof public.scheduled_emails
language sql
as $$
  update public.scheduled_emails
     set status = 'sending', attempts = attempts + 1, updated_at = now()
   where id in (
     select id from public.scheduled_emails
      where status = 'pending' and send_at <= now()
      order by send_at
      limit max_rows
      for update skip locked
   )
  returning *;
$$;

-- If a run died mid-send, put 'sending' rows back to pending.
create or replace function public.recover_stuck(stale_minutes int default 10)
returns void
language sql
as $$
  update public.scheduled_emails
     set status = 'pending', updated_at = now()
   where status = 'sending' and updated_at < now() - make_interval(mins => stale_minutes);
$$;

-- Access: only the Edge Functions' service role. Granted explicitly so this works even when
-- "Automatically expose new tables" is off for the project.
revoke all on table public.scheduled_emails, public.chat_sessions from anon, authenticated;
grant select, insert, update, delete on table public.scheduled_emails, public.chat_sessions to service_role;
revoke execute on function public.claim_due(int) from public, anon, authenticated;
revoke execute on function public.recover_stuck(int) from public, anon, authenticated;
grant execute on function public.claim_due(int) to service_role;
grant execute on function public.recover_stuck(int) to service_role;

-- Every minute, call the send-due Edge Function. The URL and shared secret live in Vault
-- (created once during setup; see SUPABASE.md), never in this file.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'send-due-emails',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/send-due',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
