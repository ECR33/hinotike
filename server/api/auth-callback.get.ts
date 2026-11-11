import { sendRedirect } from 'h3'
import { serverSupabaseClient } from '#supabase/server'
import { isSafeLocalPath, type AuthErrorCode } from '#shared/utils/auth'

/**
 * Supabase(Google) OAuth のリダイレクト受け口。
 * ダッシュボードの Auth → Redirect URLs に <site-url>/api/auth-callback を登録する。
 *
 * 処理(参考: slack2mail の auth-callback を単一テナント化):
 * 1. code をセッションに交換(PKCE verifier は cookie にある)
 * 2. link_my_user() RPC で事前登録行を自動紐付け
 *    (失敗しても session は確立済み。RLS が未紐付けを拒否するので安全性は損なわれない — 致命的にしない)
 * 3. 検証済みの returnTo へリダイレクト
 *
 * エラーは固定コードのみ URL に載せる。内部メッセージはログに出し、画面には出さない。
 */
export default defineEventHandler(async (event) => {
  if (!isSupabaseConfigured(event)) {
    return sendRedirect(event, '/login?error=not_configured', 302)
  }

  const query = getQuery(event)
  const code = typeof query.code === 'string' ? query.code : ''
  const returnTo = isSafeLocalPath(query.returnTo) ? query.returnTo : '/scan'

  if (!code) {
    const err: AuthErrorCode = query.error === 'access_denied' ? 'access_denied' : 'no_code'
    return sendRedirect(event, `/login?error=${err}`, 302)
  }

  const supabase = await serverSupabaseClient(event)
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    console.error('[auth-callback] exchangeCodeForSession:', error.message)
    return sendRedirect(event, '/login?error=exchange_failed', 302)
  }

  // ログイン確定後に一度だけ呼ぶ自動紐付け(SECURITY DEFINER RPC, email 一致でのみ紐付け)
  const { error: linkError } = await supabase.rpc('link_my_user')
  if (linkError) {
    console.error('[auth-callback] link_my_user:', linkError.message)
  }

  return sendRedirect(event, returnTo, 302)
})
