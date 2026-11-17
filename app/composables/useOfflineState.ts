import type { OfflineMeta } from '#shared/utils/offline'

/**
 * オフラインモードの画面側状態(SSR は storage を読めないので既定は「無効」)。
 * - meta: localStorage のスナップショットメタ(onMounted で引き当てる。初回描画は SSR と同じ null で hydration mismatch を避ける)。
 * - queueCount: IndexedDB のオフライン記録の待機件数(復旧確定ボタンBanner用)。
 * ページは top-level に分解した computed/ref を置く(template の自動 unwrap を使う)。
 */
export function useOfflineState() {
  const meta = useState<OfflineMeta | null>('offline-meta', () => null)
  const queueCount = useState<number>('offline-queue-count', () => 0)
  const enabled = computed(() => meta.value?.enabled === true)

  async function refreshQueueCount(): Promise<void> {
    if (!import.meta.client) return
    try {
      queueCount.value = await offlineQueueCount()
    } catch {
      // IndexedDB が無い/開けない環境は件数だけ 0 のまま(スキャン自体は失敗側で注記が出る)
    }
  }

  onMounted(() => {
    meta.value = readOfflineMetaFromStorage()
    void refreshQueueCount()
  })

  return { meta, queueCount, enabled, refreshQueueCount }
}
