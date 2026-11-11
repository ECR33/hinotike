import { sendRedirect } from 'h3'
import { isSafeLocalPath } from '#shared/utils/auth'

/**
 * OAuth がサイトルート(例: http://localhost:3000/?code=...)へ
 * 帰還した場合(Supabase の Site URL へリダイレクトされた場合)の救済。
 * /api/auth-callback に code / error / returnTo を引き継いで正規の処理経路に流す。
 * returnTo は isSafeLocalPath で厳格化する(callback 側でも再検証される)。
 */
export default defineEventHandler((event) => {
  const query = getQuery(event)
  const path = event.path.split('?')[0] || '/'

  if (path === '/' && typeof query.code === 'string' && query.code) {
    const returnTo = isSafeLocalPath(query.returnTo) ? query.returnTo : '/scan'
    const parts = [`code=${encodeURIComponent(query.code)}`, `returnTo=${encodeURIComponent(returnTo)}`]
    if (typeof query.error === 'string' && query.error) {
      parts.push(`error=${encodeURIComponent(query.error)}`)
    }
    return sendRedirect(event, `/api/auth-callback?${parts.join('&')}`, 302)
  }
})
