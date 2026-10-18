create table public.messages (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) <= 80),
  message text not null check (char_length(message) <= 500),
  created_at timestamptz not null default now()
);

alter table public.messages enable row level security;

create policy "Anyone can read messages" on public.messages for select using (true);
create policy "Anyone can sign the guestbook" on public.messages for insert with check (true);
