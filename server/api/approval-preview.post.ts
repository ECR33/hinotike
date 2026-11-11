

/**
 * 許可前確認(preview)。許可済みの利用者(requireRegisteredUser)のみ。
 * RPC は消費せず、依頼の有効性と依頼者の email/name を返す。
 * スキャンした人は「誰を許可するか」を確認してから承認する(人間の承認責任を残す)。
 */
export default defineEventHandler(async (event) => {
  const nonce = await requireApprovalNonce(event)
  // ガードが返す client(認証済みセッションのクライアント)で RPC を呼ぶ(auth.role() = authenticated)
  const { supabase } = await requireRegisteredUser(event)
  const { data, error } = await supabase.rpc('preview_registration_request', { req_nonce: nonce })
  if (error) {
    console.error('[approval-preview] rpc:', error.message)
    throw createError({ statusCode: 500, statusMessage: 'preview failed' })
  }
  return data as { status: string; email?: string; name?: string }
})
