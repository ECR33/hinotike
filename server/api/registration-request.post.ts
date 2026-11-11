import { serverSupabaseClient } from '#supabase/server'
import { REGISTRATION_QR_PREFIX } from '#shared/utils/registration'

/**
 * 未登録の認証ユーザが「許可依頼」を作成する(許可依頼QRの nonce を発行)。
 * 依頼の作成は RPC(create_registration_request, SECURITY DEFINER)が行い、
 * auth.uid() の依頼行だけを1本作る(同じユーザの古い依頼は失効される)。
 * サーバーは依頼者の uid をクライアント入力から受け取らない。
 */
export default defineEventHandler(async (event) => {
  // ログイン必須。未登録でも可(依頼自体は未登録ユーザが作る)。
  await requireUser(event)

  const supabase = await serverSupabaseClient(event)
  const { data, error } = await supabase.rpc('create_registration_request')
  if (error) {
    console.error('[registration-request] rpc:', error.message)
    throw createError({ statusCode: 500, statusMessage: 'request creation failed' })
  }

  const res = data as { status: string; nonce?: string; expires_at?: string }
  if (res.status === 'already_registered') {
    throw createError({ statusCode: 409, statusMessage: 'already_registered' })
  }
  if (res.status !== 'ok' || !res.nonce) {
    console.error('[registration-request] unexpected status:', res.status)
    throw createError({ statusCode: 500, statusMessage: 'request creation failed' })
  }

  return {
    token: `${REGISTRATION_QR_PREFIX}${res.nonce}`,
    expiresAt: res.expires_at ?? null,
  }
})
