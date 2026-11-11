import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * 現在の認証状態と、users テーブルへの紐付け有無を返す。
 * セッションはモジュール(serverSupabaseUser)が cookie から解決する。
 * users 照会は RLS(users_self_select: auth_user_id = auth.uid())を通し、
 * 明示的な eq('auth_user_id', user.id) も併用する(防御の二重化)。
 */
export default defineEventHandler(async (event) => {
  if (!isSupabaseConfigured(event)) {
    return { authenticated: false, authorized: false, email: null }
  }

  const user = await serverSupabaseUser(event)
  if (!user) {
    return { authenticated: false, authorized: false, email: null }
  }

  // モジュール 2.x の serverSupabaseUser は JWT クレームを返す(id ではなく sub に UUID が入る)。
  // 旧形状(id)との両対応で UUID を取得する。
  const uid = (user as { id?: string; sub?: string }).sub ?? user.id
  if (!uid) {
    console.error('[me] user object has no uuid (id/sub)')
    throw createError({ statusCode: 500, statusMessage: 'session invalid' })
  }

  const supabase = await serverSupabaseClient(event)
  const { data, error } = await supabase
    .from('users')
    .select('id, email, name')
    .eq('auth_user_id', uid)
    .maybeSingle()

  if (error) {
    console.error('[me] users lookup:', error.message)
    throw createError({ statusCode: 500, statusMessage: 'users lookup failed' })
  }

  return {
    authenticated: true,
    authorized: data != null,
    email: user.email ?? data?.email ?? null,
  }
})
