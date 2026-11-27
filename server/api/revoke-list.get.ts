/**
 * リボーク画面の利用者一覧。権限は RPC list_users の can_purge ガードが集約する。
 * users は RLS(users_self_select)で自分行しか読めないため、一覧は definer RPC で引き、
 * API はその status をそのまま返す(forbidden は 403 にマップ)。
 */
export default defineEventHandler(async (event) => {
  const { supabase } = await requireRegisteredUser(event)
  const { data, error } = await supabase.rpc('list_users')
  if (error) {
    console.error('[revoke-list] rpc:', error.message)
    throw createError({ statusCode: 500, statusMessage: 'users list failed' })
  }
  const res = data as { status: string; users?: unknown[] }
  if (res.status === 'forbidden') {
    throw createError({ statusCode: 403, statusMessage: 'not a can_purge user' })
  }
  return { users: res.users ?? [] }
})
