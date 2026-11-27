-- Hinotike: 端末ミラーの中央消去指示(0011)
--
-- 目的: QRスキャンのイベントが終了したら、端末にコピーした items データ(氏名・備考を含むミラー)を
-- 利用者の自発的な削除に任せず、中央(= Supabase DB)の指示で端末側が自動的に捨てる。
-- 設計: docs/purge-design.md
--
-- 形: 「指示」はデータセット(sync_sources)単位の単調カウンタ purge_epoch の +1。
-- 端末は取り込み時の epoch をメタに持つ。現在 epoch > メタの epoch ならそのミラーを捨てる
-- (単調増加なので replay 安全・idempotent。端末が次回オンラインになったときに必ず apply される)。
-- 指示を出せるのは users.can_purge = true の利用者だけ(最初期ユーザの事前登録 insert で true を入れる)。
-- 監査: purge_events は select/insert のみ(scan_events と同じ「証跡は不変」方針)。
--
-- 実行順: alter table → purge_events テーブル+RLS → RPC → grant。

alter table public.users
  add column if not exists can_purge boolean not null default false;

alter table public.sync_sources
  add column if not exists purge_epoch integer not null default 0;

create table if not exists public.purge_events (
  seq bigserial unique,
  id uuid primary key default gen_random_uuid(),
  source_id integer references public.sync_sources (id) on delete set null,
  actor_email text,
  issued_by uuid references auth.users (id) on delete set null,
  at timestamptz not null default now()
);

alter table public.purge_events enable row level security;

create policy "purge_events_select_registered"
  on public.purge_events for select
  to authenticated
  using (public.is_registered_user());

-- insert は definer の issue_dataset_purge() のみが行う(クライアントから直接の insert ポリシーは作らない)。

-- 消去指示の発動: can_purge ユーザのみ。sync_sources.purge_epoch を +1 し、監査行を残す。
create function public.issue_dataset_purge(p_source_id integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  new_epoch integer;
  my_email text;
begin
  if auth.role() <> 'authenticated' then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if not exists (
    select 1 from public.users u
    where u.auth_user_id = auth.uid() and u.can_purge
  ) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  update public.sync_sources
     set purge_epoch = purge_epoch + 1
   where id = p_source_id
   returning purge_epoch into new_epoch;
  if new_epoch is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  select lower(email) into my_email from auth.users where id = auth.uid();
  insert into public.purge_events (source_id, actor_email, issued_by)
    values (p_source_id, my_email, auth.uid());

  return jsonb_build_object('status', 'ok', 'source_id', p_source_id, 'purge_epoch', new_epoch);
end;
$$;

revoke execute on function public.issue_dataset_purge(integer) from anon, public;
grant execute on function public.issue_dataset_purge(integer) to authenticated;
