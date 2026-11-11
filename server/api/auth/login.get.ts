import { sendRedirect, getHeader } from 'h3'
import { serverSupabaseClient } from '#supabase/server'
import { isSafeLocalPath, publicOrigin } from '#shared/utils/auth'

/**
 * Google OAuth の開始。ログイン開始はサーバー側で行う(ブラウザ client は使わない)。
 * skipBrowserRedirect で URL を受け取り、自側で sendRedirect する
 * (PKCE verifier はモジュールが cookie に保存するため、リダイレクト後に交換できる)。
 *
 * リダイレクト先は config.public.appUrl(本番の公開baseUrl)優先、未設定ならリクエストの Host。
 * returnTo は isSafeLocalPath で厳格化し、callback に引き継ぐ。
 */
export default defineEventHandler(async (event) => {
  if (!isSupabaseConfigured(event)) {
    return sendRedirect(event, '/login?error=not_configured', 302)
  }

  const config = useRuntimeConfig(event)
  const query = getQuery(event)
  const returnTo = isSafeLocalPath(query.returnTo) ? query.returnTo : '/scan'

  const origin = publicOrigin({
    appUrl: String(config.public.appUrl ?? ''),
    forwardedHost: getHeader(event, 'x-forwarded-host') ?? undefined,
    forwardedProto: getHeader(event, 'x-forwarded-proto') ?? undefined,
    requestOrigin: getRequestURL(event).origin,
  })
  const redirectTo = `${origin}/api/auth-callback?returnTo=${encodeURIComponent(returnTo)}`

  const supabase = await serverSupabaseClient(event)
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  })

  if (error || !data?.url) {
    console.error('[auth/login] signInWithOAuth:', error?.message)
    return sendRedirect(event, '/login?error=oauth_start_failed', 302)
  }

  return sendRedirect(event, data.url, 302)
})
