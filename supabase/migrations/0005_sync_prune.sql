-- Hinotike: 同期の prune(シートに無い code を削除する運用)を追加(0004 の後に適用する)
--
-- 目的: 行フィルタで有効でなくなった行が items に残らないよう、確定時に
-- 「今回のシートで取り込み対象だった code に含まれない行」を削除できる。
-- オプション(既定 false): sync_settings.prune_on_commit。shared/utils/sync.ts / API / CLI が共通で読む。
--
-- 安全ガード(実装側、削除しない条件):
-- - 設定の worksheet が実際のシート名と不一致(フォールバック)→ 削除しない
-- - 取り込み対象が 0 行(全行がフィルタ除外/シート空)→ 削除しない
-- - プレビューで deleteCount を表示してから確定(confirm: true)のみで実行
--
-- 0003 では削除ポリシーを意図的に作っていなかった(prune がオプショナルな操作として導入される)。
-- 権限は既存の insert/update と同じ「登録済みユーザのみ」。

alter table public.sync_settings add column if not exists prune_on_commit boolean not null default false;

-- CREATE POLICY は IF NOT EXISTS 非対応なので pg_policies を見て再実行安全にする。
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'items' and policyname = 'items_delete_registered'
  ) then
    create policy "items_delete_registered"
      on public.items for delete
      to authenticated
      using (public.is_registered_user());
  end if;
end $$;
