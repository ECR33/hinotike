-- Hinotike: 同期設定(UI から編集)+ items の書き込み権限
-- 実行順: テーブル → RLS ポリシー(is_registered_user() は 0001 で作成済み) → grant → シード行
-- ホスト版の SQL Editor で実行する場合もこの順(supabase/migrations/*.sql の 0001 → 0002 → 0003)。
--
-- 設計:
-- - 同期設定は public.sync_settings の 1 行(id=1 固定)が正。/sync の管理 UI から編集する。
-- - 同期の実行は Cloudflare Worker 上の API(/api/sync-preview, /api/sync-commit)。
--   アプリサーバーは Supabase の Secret key を使わない(items の書き込みも
--   登録済みユーザの RLS ポリシーを通す)。Secret key は不要になった。
-- - 権限は「登録済みユーザ(is_registered_user())」のみ。読み込みトリガーも同じ条件。
-- - 削除ポリシーは作らない(取り込みは upsert のみ。シートに無い code を消す操作は UI に無い)。

create table if not exists public.sync_settings (
  id int primary key default 1 check (id = 1), -- singleton 行
  spreadsheet_id text not null default '',     -- 未設定('')のときは同期不可
  worksheet text,                              -- null/空 = 最初のワークシート
  code_column text not null default 'ID',
  include_columns text[] not null default '{}', -- 空 = 全カラム
  exclude_columns text[] not null default '{}', -- include_columns が空のときに除外
  rename jsonb not null default '{}'::jsonb,
  target_table text not null default 'items',
  updated_at timestamptz not null default now(),
  updated_by text                              -- 最後に編集したユーザの email(監査用)
);

alter table public.sync_settings enable row level security;

-- 登録済みユーザのみ設定の閲覧・編集が可能(同期トリガーと同じ権限)。
create policy "sync_settings_select_registered"
  on public.sync_settings for select
  to authenticated
  using (public.is_registered_user());

create policy "sync_settings_insert_registered"
  on public.sync_settings for insert
  to authenticated
  with check (public.is_registered_user());

create policy "sync_settings_update_registered"
  on public.sync_settings for update
  to authenticated
  using (public.is_registered_user())
  with check (public.is_registered_user());

-- items の書き込み(同期の upsert)。読み取りは 0001 の items_select_registered_users。
create policy "items_insert_registered"
  on public.items for insert
  to authenticated
  with check (public.is_registered_user());

create policy "items_update_registered"
  on public.items for update
  to authenticated
  using (public.is_registered_user())
  with check (public.is_registered_user());

-- 明示 grant(default privileges に任せず、既存マイグレーションの方針に合わせておく)。
grant select, insert, update on table public.sync_settings to authenticated;

-- シード行。値は shared/utils/sync.ts の DEFAULT_SYNC_SETTINGS と同じ(片方を変えたらもう片方も直す)。
-- spreadsheet_id は空で置く(スプレッドシート ID は UI から設定する)。
insert into public.sync_settings (
  id, spreadsheet_id, worksheet, code_column, include_columns, exclude_columns, rename, target_table
)
values (
  1,
  '',
  'フォームの回答 1',
  'ID',
  array['学年','クラス','氏名','支払い方法','領収書が必要な方はチェックをお願いします。','購入金額','入金状況','入金額','ひのドッグ(個数)','やきそば(個数)','麦茶(個数)','サイダー(個数)','カルピス(個数)','りんご(個数)','ゲーム(個数)','備考']::text[],
  '{}',
  '{"領収書が必要な方はチェックをお願いします。":"領収書"}'::jsonb,
  'items'
)
on conflict (id) do nothing;
