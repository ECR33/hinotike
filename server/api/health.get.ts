/**
 * 設定の有無だけを返すヘルスチェック。
 * 値・環境変数名・内部メッセージは露出しない(真偽のみ)。
 */
export default defineEventHandler(() => {
  const config = useRuntimeConfig()
  const supabase = config.public?.supabase ?? {}
  return {
    timestamp: new Date().toISOString(),
    configured: {
      supabaseUrl: Boolean(supabase.url),
      supabaseKey: Boolean(supabase.key),
      appUrl: Boolean(config.public?.appUrl),
    },
  }
})
