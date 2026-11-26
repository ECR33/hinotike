-- Hinotike: レガシーテーブルの撤去(0008 の後に適用する)
--
-- 目的: 「シート → Supabase の items に upsert → サーバーが items を照会」の方式を完全にやめた
-- (2026-11-22 のデータの端末保有化で照会・一覧・スキャンは端末の IndexedDB が読み、
--  2026-11-26 にサーバー側の照会API(/api/items-list, items-facets, items-keys, lookup, scan-check)を撤去した)。
-- 残るのは「シートから端末へ取り込み / 端末で照会 / シートへ書き戻し」の経路だけ。
--
-- 消すもの:
-- - public.items(データ本体のテーブル。0001 で作成、0008 で書き込み権限を撤去済み。残る select ポリシーも消す)
-- - public.sync_settings(旧 singleton の同期設定。0007 の sync_sources に置き換え済み、0008 で読み取りのみ残していた)
-- - それらの RLS ポリシー(grant は drop table で一緒に消える)
--
-- 残るテーブル: users / user_email_domains / registration_requests(認証とQR許可)、
-- sync_sources(取り込み定義)、scan_modes / scan_events(記録モードと証跡)。
-- データ本体は Supabase に置かない(シートが唯一の正、行は端末に置く)。
--
-- 実行順: ポリシー → テーブル drop(`drop ... if exists` で再実行安全。drop table は policies も消す)。

drop policy if exists "items_select_registered_users" on public.items;
drop policy if exists "items_insert_registered" on public.items;
drop policy if exists "items_update_registered" on public.items;
drop policy if exists "items_delete_registered" on public.items;

drop policy if exists "sync_settings_select_registered" on public.sync_settings;
drop policy if exists "sync_settings_insert_registered" on public.sync_settings;
drop policy if exists "sync_settings_update_registered" on public.sync_settings;

-- テーブルとその policies / indexes / grants をまとめて消す(grants は drop table で一緒に消えるので
-- 明示 revoke は不要。drop 済みのテーブルへの revoke は SQLSTATE 42P01 になる)。
drop table if exists public.items;
drop table if exists public.sync_settings;
