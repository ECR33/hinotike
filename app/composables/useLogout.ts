import type { MeState } from '#shared/utils/auth'
import type { OfflineMeta } from '#shared/utils/offline'
import { offlineQueueCount, purgeDeviceData } from '~/utils/offlineStore'

/**
 * サーバー側ログアウト(/api/logout)+ **この端末のデータの削除**(`purgeDeviceData()`)。
 * 端末内のミラー(IndexedDB)は氏名・備考を含むので、ログアウトで一緒に捨てる
 * (「ためた記録」は捨てずに **氏名だけ除去**して code / modeId / at を残す = 通信が戻れば確定できる)。
 * ミラーは再取り込みで戻るので、ログアウト後にオフライン運用するには通信のある場所で取り込み直す。
 * 旧実装の「ブラウザ client signOut + サーバー cookie 削除」の二重ログアウトは撤去した。
 */
export function useLogout() {
  const authState = useState<MeState | null>('auth-state', () => null)
  const offlineMeta = useState<OfflineMeta | null>('offline-meta', () => null)
  const offlineQueueState = useState<number>('offline-queue-count', () => 0)

  async function logout() {
    // 端末データの削除は client のストレージ操作(SSR では何もしない)
    if (import.meta.client) {
      await purgeDeviceData().catch(() => undefined)
      offlineMeta.value = null
      offlineQueueState.value = await offlineQueueCount().catch(() => 0)
    }
    await $fetch<{ ok: boolean }>('/api/logout', { method: 'POST' })
    authState.value = { authenticated: false, authorized: false, email: null, uid: null }
    await navigateTo('/')
  }

  return { logout }
}
