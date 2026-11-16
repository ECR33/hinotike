-- Hinotike: スキャンの記録モードと証跡(0005 の後に適用する)
--
-- 目的: QRスキャンを「照会」だけでなく「確認した証跡の記録」にも使う。
-- 設計(doc/docs/scan-modes.md):
-- - scan_modes は 1行 = 1モード。/scan のモード選択と「新しい記録を作る」から増減する(動的増減)。
--   actions は [{ column, column_at, literal, payload_key, payload_at_key }] の jsonb。
--   column/column_at はシートのヘッダー名(rename 前の実名。remark-update と同じ基準)。
-- - 書く値は「済/未 フラグ + 日時」の2本。日時列を省略したモードも作れる(表示側は日時があれば済扱い)。
-- - scan_events は不変の履歴(監査)。シートセルは1値しか残らないので「いつ読み込んだか」の正はここ。
--   mode_name / name は denormalize して写す(モード削除・items 削除後も履歴が読める)。
-- 権限は既存の同期設定と同じ「登録済みユーザのみ」(public.is_registered_user() は 0001 で作成済み)。
-- scan_events は insert/select のみ(update/delete ポリシーを作らない = 証跡は不変)。

create table if not exists public.scan_modes (
  id serial primary key,
  name text not null unique,
  actions jsonb not null default '[]'::jsonb,
  -- 重複QRの扱い: warn = 記録しつつ警告 / skip = 記録しない / allow = 記録する(上書き)
  dedupe text not null default 'warn' check (dedupe in ('warn', 'skip', 'allow')),
  -- true = 氏名を確認してから記録(来場・チェックイン)。false = 読み取った順にそのまま記録(棚卸し・配布)
  confirm_before_record boolean not null default false,
  -- items に見つからない code を拒否するか(false = シート行があれば書き込み可)
  require_found boolean not null default true,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.scan_modes enable row level security;

create policy "scan_modes_select_registered"
  on public.scan_modes for select
  to authenticated
  using (public.is_registered_user());

create policy "scan_modes_insert_registered"
  on public.scan_modes for insert
  to authenticated
  with check (public.is_registered_user());

create policy "scan_modes_update_registered"
  on public.scan_modes for update
  to authenticated
  using (public.is_registered_user())
  with check (public.is_registered_user());

create policy "scan_modes_delete_registered"
  on public.scan_modes for delete
  to authenticated
  using (public.is_registered_user());

grant select, insert, update, delete on table public.scan_modes to authenticated;

-- 証跡(1読み取り = 1行。ok/duplicate/not_found/sheet_missing/write_failed/skipped をすべて残す)
-- seq は insertion 順のキーセット分页用(bigserial)。uuid は time-order ではないので「新しい順」のカーソルに使える。
create table if not exists public.scan_events (
  seq bigserial unique,
  id uuid primary key default gen_random_uuid(),
  code text not null,
  mode_id integer references public.scan_modes(id) on delete restrict,
  mode_name text not null,
  name text,                       -- 記録時点の氏名(denormalize。items 削除後も読める)
  actor_email text,
  status text not null check (status in ('ok', 'duplicate', 'not_found', 'sheet_missing', 'write_failed', 'skipped')),
  written jsonb not null default '{}'::jsonb,  -- { "来場済": "済", "来場日時": "2026-11-16 09:02 (JST)" }
  sheet_range text,
  at timestamptz not null default now()
);

alter table public.scan_events enable row level security;

create policy "scan_events_select_registered"
  on public.scan_events for select
  to authenticated
  using (public.is_registered_user());

create policy "scan_events_insert_registered"
  on public.scan_events for insert
  to authenticated
  with check (public.is_registered_user());

grant select, insert on table public.scan_events to authenticated;

-- /records の「ある code の履歴」照会と mode/at の絞り込み用
create index if not exists scan_events_code_at_idx on public.scan_events (code, at desc);
create index if not exists scan_events_mode_at_idx on public.scan_events (mode_name, at desc);

-- 既定のプリセット2つ。列がシートに無いときは /scan の「列を追加」で作れる(§ scan-columns API)。
insert into public.scan_modes (name, actions, dedupe, confirm_before_record)
values
  (
    'チケット配布',
    '[{"column":"配布済","column_at":"配布日時","literal":"済","payload_key":"配布済","payload_at_key":"配布日時"}]'::jsonb,
    'warn',
    false
  ),
  (
    'チェックイン',
    '[{"column":"来場済","column_at":"来場日時","literal":"済","payload_key":"来場済","payload_at_key":"来場日時"}]'::jsonb,
    'warn',
    true
  )
on conflict (name) do nothing;
