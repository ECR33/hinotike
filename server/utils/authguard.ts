import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'
import type { H3Event } from 'h3'

/**
 * API 用の認証ガード。server/utils なので nitro の auto-import で使える。
 * 設定の有無判定と「ログイン必須」「登録必須」を1箇所に集約する。
 * 登録判定は RLS と同じ根(public.is_registered_user())に集約し、二重実装のズレを防ぐ。
 */

export function isSupabaseConfigured(event: H3Event): boolean {
  const config = useRuntimeConfig(event)
  return Boolean(config.public?.supabase?.url && config.public?.supabase?.key)
}

/** ログイン必須(401)。モジュールの serverSupabaseUser が cookie からセッションを解決する。 */
export async function requireUser(event: H3Event) {
  if (!isSupabaseConfigured(event)) {
    throw createError({ statusCode: 500, statusMessage: 'Supabase not configured (.env missing)' })
  }
  const user = await serverSupabaseUser(event)
  if (!user) {
    throw createError({ statusCode: 401, statusMessage: 'Not authenticated' })
  }
  return user
}

/** ログイン済み + users テーブルへの紐付けも必須(403)。 */
export async function requireRegisteredUser(event: H3Event) {
  const user = await requireUser(event)
  const supabase = await serverSupabaseClient(event)

  const { data, error } = await supabase.rpc('is_registered_user')
  if (error) {
    console.error('[authguard] is_registered_user:', error.message)
    throw createError({ statusCode: 500, statusMessage: 'registration check failed' })
  }
  if (!data) {
    throw createError({ statusCode: 403, statusMessage: 'Not registered in users table' })
  }

  return { user, supabase }
}
