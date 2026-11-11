import { serverSupabaseClient } from '#supabase/server'
import { deleteCookie } from 'h3'

/**
 * ログアウトはサーバー側1系統のみ(モジュールの signOut + sb-* cookie 削除)。
 * クライアント browser client での signOut との二重ログアウトは撤去した。
 */
export default defineEventHandler(async (event) => {
  if (isSupabaseConfigured(event)) {
    const supabase = await serverSupabaseClient(event)
    const { error } = await supabase.auth.signOut()
    if (error) console.error('[logout] signOut:', error.message)
  }

  // 念のため Supabase 系 cookies を明示的に削除
  const raw = getRequestHeader(event, 'cookie') ?? ''
  for (const part of raw.split(';')) {
    const [name] = part.trim().split('=')
    if (name && name.startsWith('sb-')) {
      deleteCookie(event, name, { path: '/' })
    }
  }

  return { ok: true }
})
