import { createClient } from '@supabase/supabase-js'

/**
 * 設定の有無 + **DB のスキーマがアプリの期待する形か**だけを返すヘルスチェック。
 * 値・環境変数名・内部メッセージは露出しない(真偽のみ)。
 *
 * `datasetTable` は `public.sync_sources` が読めるか(マイグレーション 0007/0008 が適用済みか)。
 * 未適用だと PostgREST は schema cache のエラー(`PGRST205`)を返すので、`false` になる。
 * これを `scripts/deploy-status.mjs` が本番で見る: コードのデプロイは成功したが DB の迁移が未適用、
 * という「デプロイは OK / アプリは壊れている」状態を早期に捉える(docs/datasets.md の 8 節)。
 * セッション不要で読める(RLS の select は匿名では 0 行。テーブルが存在すれば error は出ない)。
 */
export default defineEventHandler(async () => {
  const config = useRuntimeConfig()
  const supabase = config.public?.supabase ?? {}
  const url = String(supabase.url ?? '')
  const key = String(supabase.key ?? '')

  let datasetTable = false
  if (url && key) {
    try {
      const client = createClient(url, key)
      const { error } = await client.from('sync_sources').select('id').limit(1)
      // 行が無い(error=null)は「テーブルはあるが定義が未作成」=  Migration 適用済みとして true。
      datasetTable = !error || error.code !== 'PGRST205'
    } catch {
      datasetTable = false
    }
  }

  return {
    timestamp: new Date().toISOString(),
    configured: {
      supabaseUrl: Boolean(url),
      supabaseKey: Boolean(key),
      appUrl: Boolean(config.public?.appUrl),
      datasetTable,
    },
  }
})
