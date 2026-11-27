import { readBody } from 'h3'

/**
 * ログイン権限のリボーク(0012)。can_purge の利用者だけ(RPC revoke_user がガード)。
 * users 行の soft revoke(revoked_at を立てる): RLS と guard の共通根 is_registered_user() が
 * 即座に全アクセスを拒否し、身分スナップショット(0010)は監査として行に残る。
 * 画面には固定の status のみ返す(approval/purge API と同じ方針)。
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: unknown }>(event)
  if (typeof body?.email !== 'string' || body.email.trim() === '') {
    throw createError({ statusCode: 400, statusMessage: 'email が必要です' })
  }

  const { supabase } = await requireRegisteredUser(event)
  const { data, error } = await supabase.rpc('revoke_user', { p_email: body.email.trim() })
  if (error) {
    console.error('[revoke-user] rpc:', error.message)
    throw createError({ statusCode: 500, statusMessage: 'revoke failed' })
  }
  return data as { status: string; email?: string }
})
