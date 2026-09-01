-- game19 排行榜表（在 Supabase Management API 中执行）
create table if not exists public.leaderboard (
  id          bigint generated always as identity primary key,
  player_name text    not null check (char_length(player_name) between 1 and 12),
  score       int     not null check (score >= 0),
  days        int     not null default 0,
  created_at  timestamptz not null default now()
);

-- 开启行级安全
alter table public.leaderboard enable row level security;

-- 所有人可读（排行榜公开显示）
drop policy if exists "lb_read_all" on public.leaderboard;
create policy "lb_read_all"
  on public.leaderboard for select to anon, authenticated using (true);

-- 任何人可提交分数
drop policy if exists "lb_insert_all" on public.leaderboard;
create policy "lb_insert_all"
  on public.leaderboard for insert to anon with check (score >= 0);
