import type { MeState } from '#shared/utils/auth'

/**
 * サーバー側ログアウト(/api/logout)のみを使う。
 * 旧実装の「ブラウザ client signOut + サーバー cookie 削除」の二重ログアウトは撤去した。
 * ミドルウェアの缓存状態も同時に更新し、ログアウト後の client 遷移で旧状態が残らないようにする。
 */
export function useLogout() {
  const authState = useState<MeState | null>('auth-state', () => null)

  async function logout() {
    await $fetch<{ ok: boolean }>('/api/logout', { method: 'POST' })
    authState.value = { authenticated: false, authorized: false, email: null }
    await navigateTo('/')
  }

  return { logout }
}
