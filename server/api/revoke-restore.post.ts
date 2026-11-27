import { readBody } from 'h3'

/**
 * リボークの解除(0012)。can_purge の利用者だけ(RPC restore_user がガード)。
 * revoked_at / revoked_by を戻す。身分スナップショットはそのまま残る。
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: unknown }>(event)
  if (typeof body?.email !== 'string' || body.email.trim() === '') {
    throw createError({ statusCode: 400, statusMessage: 'email が必要です' })
  }

  const { supabase } = await requireRegisteredUser(event)
  const { data, error } = await supabase.rpc('restore_user', { p_email: body.email.trim() })
  if (error) {
    console.error('[revoke-restore] rpc:', error.message)
    throw createError({ statusCode: 500, statusMessage: 'restore failed' })
  }
  return data as { status: string; email?: string }
})
