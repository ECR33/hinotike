-- Hinotike: 複数のデータセット(スプレッドシート)の取り込み定義(0006 の後に適用する)
--
-- 目的: 「1つの Spreadsheet を Supabase に取り込み」を「複数の Spreadsheet を端末に取り込み」に変える。
-- 設計(doc/docs/datasets.md):
-- - public.sync_sources は 1行 = 1データセット(スプレッドシート + ワークシート + code カラム + 選別)。
--   /sync の管理 UI から追加・編集・削除する(旧 sync_settings の singleton 行は置き換えられる)。
-- - 取り込み**定義**だけ DB に置く。データ本体は Supabase に置かない:
--   GET /api/import がシートを読み、画面が IndexedDB に保存する(シートが唯一の正)。
-- - 取り込みの実行は Worker 上の API(/api/import, /api/source-preview)。
--   アプリサーバーは Supabase の Secret key を使わない(登録済みユーザの RLS ポリシーを通す)。
-- - 旧 items テーブルの書き込み権限(items_insert_registered / items_update_registered)は
--   0008 で撤去する(API が items を読まない・書かないようになったため)。
-- 権限は既存の同期設定と同じ「登録済みユーザのみ」(public.is_registered_user() は 0001 で作成済み)。

create table if not exists public.sync_sources (
  id serial primary key,
  name text not null unique,                       -- 画面の選択に出す表示名(重複不可)
  spreadsheet_id text not null default '',         -- 未設定('')のときは取り込み不可
  worksheet text,                                  -- null/空 = 最初のワークシート
  code_column text not null default 'ID',          -- QR 照会キーになるヘッダー名
  include_columns text[] not null default '{}',    -- 空 = 全カラム。非空 = この許容リストのみ
  exclude_columns text[] not null default '{}',    -- include_columns が空のときに除外
  filter_column text,                              -- null/空 = 行フィルタなし(全行が対象)
  filter_values text[] not null default '{}',      -- 空 = そのカラムの値が非空なら有効
  rename jsonb not null default '{}'::jsonb,       -- { "元カラム名": "新キー名" }
  enabled boolean not null default true,           -- false = 画面の選択に出さない(削除せず運用停止)
  created_at timestamptz not null default now(),
  updated_at timestamptz default now(),
  updated_by text                                  -- 最後に編集したユーザの email(監査用)
);

alter table public.sync_sources enable row level security;

-- 登録済みユーザのみ定義の閲覧・編集が可能(旧 sync_settings と同じ権限)。
create policy "sync_sources_select_registered"
  on public.sync_sources for select
  to authenticated
  using (public.is_registered_user());

create policy "sync_sources_insert_registered"
  on public.sync_sources for insert
  to authenticated
  with check (public.is_registered_user());

create policy "sync_sources_update_registered"
  on public.sync_sources for update
  to authenticated
  using (public.is_registered_user())
  with check (public.is_registered_user());

-- データセットの削除は「記録モード(scan_modes.source_id)が無いとき」だけ通る(FK は restrict)。
create policy "sync_sources_delete_registered"
  on public.sync_sources for delete
  to authenticated
  using (public.is_registered_user());

grant select, insert, update, delete on table public.sync_sources to authenticated;
create index if not exists sync_sources_enabled_idx on public.sync_sources (enabled, id);

-- シード。値は shared/utils/sync.ts の DEFAULT_SOURCE と同じ(片方を変えたらもう片方も直す)。
-- spreadsheet_id は空で置く(スプレッドシート ID は UI から設定する)。
insert into public.sync_sources (
  name, spreadsheet_id, worksheet, code_column, include_columns, exclude_columns, filter_column, filter_values, rename
)
values (
  '既定のシート',
  '',
  'フォームの回答 1',
  'ID',
  array['学年','クラス','氏名','支払い方法','領収書が必要な方はチェックをお願いします。','購入金額','入金状況','入金額','ひのドッグ(個数)','やきそば(個数)','麦茶(個数)','サイダー(個数)','カルピス(個数)','りんご(個数)','ゲーム(個数)','備考']::text[],
  '{}',
  null,
  '{}',
  '{"領収書が必要な方はチェックをお願いします。":"領収書"}'::jsonb
)
on conflict (name) do nothing;

-- 旧 sync_settings(id=1 行)の中身を 1データセットとして引き継ぐ(移行: 設定を失わない)。
-- 既存の「既定のシート」行があれば更新し、無ければ作る。spreadsheet_id が空のままでも作成する。
insert into public.sync_sources (
  name, spreadsheet_id, worksheet, code_column, include_columns, exclude_columns, filter_column, filter_values, rename, updated_by
)
select
  '旧設定(sync_settings)',
  s.spreadsheet_id,
  s.worksheet,
  s.code_column,
  s.include_columns,
  s.exclude_columns,
  null,
  '{}',
  s.rename,
  s.updated_by
from public.sync_settings s
where s.id = 1 and s.spreadsheet_id <> ''
  and not exists (select 1 from public.sync_sources where sync_sources.spreadsheet_id = s.spreadsheet_id)
on conflict (name) do nothing;