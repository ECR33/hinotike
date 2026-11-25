-- Hinotike: 記録モードと証跡をデータセットに紐づける(0007 の後に適用する)
--
-- 目的: 記録列名はシート固有なので、モードは「どのデータセットに書くか」を持つ。
-- 設計(doc/docs/datasets.md):
-- - scan_modes.source_id → sync_sources(id)。on delete restrict(記録モードが載るデータセットは消せない)。
-- - scan_events.source_id は denormalize の監査値(モード削除後も「どのシートへの記録か」が読める)。
-- - items テーブルは**レガシー化**: API は読まないし書かない(シートが唯一の正)。
--   items の insert/update ポリシーを撤去し、select のみ残す(旧データの参照用。削除はしない)。

alter table public.scan_modes add column if not exists source_id integer references public.sync_sources(id) on delete restrict;
alter table public.scan_events add column if not exists source_id integer;

create index if not exists scan_modes_source_idx on public.scan_modes (source_id, id);
create index if not exists scan_events_source_at_idx on public.scan_events (source_id, at desc);

-- 既存モードを最初のデータセットに紐づける(バックフィル: 紐なしのモードは API が 400 にする)。
update public.scan_modes m
set source_id = s.id
from public.sync_sources s
where m.source_id is null
  and s.id = (select min(id) from public.sync_sources);

-- scan_events の既存行も同じデータセットで補う(監査の「どのシートか」を空にしない)。
update public.scan_events e
set source_id = m.source_id
from public.scan_modes m
where e.source_id is null and e.mode_id = m.id and m.source_id is not null;

-- items は書き込まない(端末ミラー + シートが正)。書き込み権限を撤去する。
drop policy if exists "items_insert_registered" on public.items;
drop policy if exists "items_update_registered" on public.items;

-- 旧 sync_settings は定義の正ではなくなった(読み取りのみ残す = 移行の参照用)。
drop policy if exists "sync_settings_insert_registered" on public.sync_settings;
drop policy if exists "sync_settings_update_registered" on public.sync_settings;