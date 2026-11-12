-- Hinotike: 同期設定に行フィルタを追加(0003 の後に適用する)
--
-- 目的: 有効レコードを表すカラムを設けているシートで、その値が許容値のいずれかだった行だけ取り込む。
-- 実装は shared/utils/sync.ts の mapSheetRows(UI/API/CLI 共通):
-- - filter_column: 行の有効/無効を表すカラム名。NULL/空 = フィルタなし(従来の動作 = 全行)
-- - filter_values: 有効とみなす値のリスト(複数可)。空リスト = そのカラムの値が非空なら有効
--   比較はセル値を文字列化 + trim 後の完全一致(大小は区別)
-- - filter_column がヘッダーに無いときは設定ミスとして同期を拒否する(API 400 / CLI 終了)
-- 既存行は既定値(NULL / '{}')でフィルタなし = 後方互換。

alter table public.sync_settings add column if not exists filter_column text;
alter table public.sync_settings add column if not exists filter_values text[] not null default '{}'::text[];
