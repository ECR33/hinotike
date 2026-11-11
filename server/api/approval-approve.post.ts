

/**
 * 許可の確定(approve)。許可済みの利用者のみ。
 * RPC(preview と同じ条件を再検証 → users への紐付け/行作成 → nonce 消費 + approved_by 記録)を呼ぶ。
 * 二度スキャンは consumed / already_registered として-idempotent に扱う。
 */
export default defineEventHandler(async (event) => {
  const nonce = await requireApprovalNonce(event)
  // ガードが返す client(認証済みセッションのクライアント)で RPC を呼ぶ(auth.role() = authenticated)
  const { supabase } = await requireRegisteredUser(event)
  const { data, error } = await supabase.rpc('approve_registration_request', { req_nonce: nonce })
  if (error) {
    console.error('[approval-approve] rpc:', error.message)
    throw createError({ statusCode: 500, statusMessage: 'approve failed' })
  }
  return data as { status: string; email?: string }
})
