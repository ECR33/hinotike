/**
 * 認証まわりの共通ユーティリティ。
 * Nuxt の #shared 経由で pages / app-middleware / server(api・nitro middleware)から import できる。
 * Nuxt 依存の import は置かない(server コンテキストでも安全に読みられるように)。
 */

export interface MeState {
  authenticated: boolean
  authorized: boolean
  email: string | null
}

/**
 * 自アプリ内の相対パスのみ許可する。
 * '//evil.example.com' や '/\evil.example.com' を通さない
 * (プロトコル相対 URL による外部ドメインへのオープンリダイレクト防止)。
 */
export function isSafeLocalPath(p: unknown): p is string {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\')
}

/** URL / UI に載せる固定エラーコード。内部メッセージは画面に露出しない。 */
export const AUTH_ERROR_CODES = [
  'access_denied',
  'no_code',
  'exchange_failed',
  'not_configured',
  'oauth_start_failed',
] as const
export type AuthErrorCode = typeof AUTH_ERROR_CODES[number]

const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  access_denied: 'Google の認可がキャンセルされました',
  no_code: '認証コードを受け取りませんでした',
  exchange_failed: '認証コードの交換に失敗しました。Site URL / Redirect URLs の設定を確認してください',
  not_configured: 'Supabase の URL / key が .env に設定されていません',
  oauth_start_failed: 'Google ログインの開始に失敗しました',
}

/** 未知のコードでも汎用文言にフォールバックする。 */
export function authErrorMessage(code: string): string {
  if ((AUTH_ERROR_CODES as readonly string[]).includes(code)) {
    return AUTH_ERROR_MESSAGES[code as AuthErrorCode]
  }
  return '認証に失敗しました'
}

/**
 * 公開 origin を組み立てる(Cloudflare 隧道経由対応)。
 * 優先順位: 設定した appUrl → x-forwarded-host/proto(隧道が付ける) → リクエストの origin。
 * 隧道経由だとリクエストの origin は localhost になるため、redirect_to に使うと Google 側で拒否される。
 */
export function publicOrigin(opts: {
  appUrl?: string
  forwardedHost?: string
  forwardedProto?: string
  requestOrigin?: string
}): string {
  if (opts.appUrl) return opts.appUrl
  const host = (opts.forwardedHost ?? '').split(',')[0]!.trim()
  if (host) return `${opts.forwardedProto ?? 'https'}://${host}`
  return opts.requestOrigin ?? ''
}
