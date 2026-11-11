import type { MeState } from '#shared/utils/auth'
import { publicOrigin } from '#shared/utils/auth'

/**
 * グローバル認証ミドルウェア(slack2mail 方式)。デフォルト拒否 + 公開ルートホワイトリスト。
 * 新しいページを作ってもデフォルトで保護される(旧実装はページ単位の middleware でつけ忘れリスクがあった)。
 *
 * SSR ではブラウザの cookie が内部 $fetch に自動で伝わらないため、
 * useRequestHeaders(['cookie']) で明示転送する(旧実装の「ログイン済みでも未認証扱い」バグの修正)。
 * 解決した認証状態は useState に缓存し、同一セッション内の連続遷移での再取得を省く。
 */
const publicRoutes = [
  '/',
  '/login',
  '/unauthorized', // 認証済み・未登録の案内ページ(middleware からここへ飛ばすため公開扱い)
  '/api/auth/login', // ログイン開始エンドポイント(素の a href で飛ぶが保険)
  '/api/auth/dev-login', // dev 限定のパスワードログイン(本番ビルドでは 404)
  '/api/auth-callback', // OAuth 戻り口(外部サイトからのリダイレクトを保護してはいけない)
]

export default defineNuxtRouteMiddleware(async (to) => {
  if (publicRoutes.includes(to.path)) return

  const authState = useState<MeState | null>('auth-state', () => null)

  let me = authState.value
  if (!me) {
    me = await $fetch<MeState>('/api/me', { headers: useRequestHeaders(['cookie']) })
    authState.value = me
  }

  // SSR の Location はリクエストの localhost URL から組み立てられる。
  // Cloudflare 隧道経由では x-forwarded-host/proto が付くので publicOrigin で公開 origin を解決する
  // (設定 appUrl 優先 → 隧道ヘッダー → リクエスト origin)。クライアント遷移は相対のまま(同一 origin)。
  const origin = import.meta.server
    ? publicOrigin({
        appUrl: String(useRuntimeConfig().public.appUrl ?? ''),
        ...(() => {
          const fwd = useRequestHeaders(['x-forwarded-host', 'x-forwarded-proto'])
          return { forwardedHost: fwd['x-forwarded-host'], forwardedProto: fwd['x-forwarded-proto'] }
        })(),
      })
    : ''

  const target = (path: string): string => (origin ? `${origin}${path}` : path)
  // SSR で別 origin(隧道経由で localhost と異なる公開URL)へ飛ぶ場合、Nuxt は既定で拒否するため external を明示する
  const opts = { redirectCode: 302 as const, external: import.meta.server && origin !== '' }

  if (!me.authenticated) {
    return navigateTo(target(`/login?returnTo=${encodeURIComponent(to.fullPath)}`), opts)
  }
  if (!me.authorized) {
    return navigateTo(target('/unauthorized'), opts)
  }
})
