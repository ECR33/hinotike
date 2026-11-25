import type { MeState } from '#shared/utils/auth'
import { mirrorBelongsToUser, type OfflineMeta } from '#shared/utils/offline'

/**
 * 「今どちらのデータセットで作業しているか」の画面側状態(SSR は storage を読めないので既定は null)。
 * - meta: 取り込み済みデータセットのメタ(localStorage のフラグ)。onMounted で引き当てる
 *   (初回描画は SSR と同じ null で hydration mismatch を避ける)。
 * - sourceId: 作業中のデータセットの id(= meta.sourceId)。null = まだ取り込んでいない。
 * - queueCount: IndexedDB の記録待機件数(復旧確定ボタンBanner用)。
 * - **uid 紐づけ**: ミラーは取り込んだ利用者の端末データなので、`meta.uid` と現在の認証状態の uid が
 *   一致するときだけローカル作業に使う(`localWork`)。不一致(別ユーザが同じブラウザでログインした)や
 *   uid 未解決は `localWork=false` = API 照会に戻す(`uidMismatch` で画面に削除の案内を出す)。
 * ページは top-level に分解した computed/ref を置く(template の自動 unwrap を使う)。
 */
export function useOfflineState() {
  const meta = useState<OfflineMeta | null>('offline-meta', () => null)
  const queueCount = useState<number>('offline-queue-count', () => 0)
  const authState = useState<MeState | null>('auth-state', () => null)
  const enabled = computed(() => meta.value?.enabled === true)
  /** 作業中のデータセット(未取り込みは null。一覧・照会・記録はこれに対して走る)。 */
  const sourceId = computed<number | null>(() => meta.value?.sourceId ?? null)
  /** ミラーが「今ログインしている利用者」のデータか(どちらの uid が欠けていても false)。 */
  const uidMatch = computed(() => mirrorBelongsToUser(meta.value, authState.value?.uid))
  /** ローカル作業に使えるか(有効フラグ + uid 一致)。false のときは通信の API 照会に戻る。 */
  const localWork = computed(() => enabled.value && uidMatch.value)
  /** ミラーがあるのに uid が一致しない = この端末のデータは別利用者のもの(削除できる旨の案内用)。 */
  const uidMismatch = computed(() => enabled.value && !uidMatch.value)

  async function refreshQueueCount(): Promise<void> {
    if (!import.meta.client) return
    try {
      queueCount.value = await offlineQueueCount()
    } catch {
      // IndexedDB が無い/開けない環境は件数だけ 0 のまま(スキャン自体は失敗側で注記が出る)
    }
  }

  /** localStorage のメタを引き当てる。ミラーがあるのに認証状態の uid が未解決なら /api/me で引く(通信が無いときは失敗 = 無効扱い)。 */
  async function refreshMeta(): Promise<void> {
    if (!import.meta.client) return
    meta.value = readOfflineMetaFromStorage()
    if (meta.value && !authState.value?.uid) {
      try {
        authState.value = await $fetch<MeState>('/api/me')
      } catch {
        // 通信が無い・認証状態を解決できないときは uid 未解決のまま = ローカル作業は使わない
      }
    }
  }

  onMounted(() => {
    void refreshMeta()
    void refreshQueueCount()
  })

  return { meta, queueCount, enabled, localWork, uidMatch, uidMismatch, sourceId, refreshQueueCount, refreshMeta }
}
