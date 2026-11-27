import { offlinePurgeSource, offlineReadMeta, readOfflineMetaFromStorage } from '~/utils/offlineStore'
import type { OfflineMeta } from '#shared/utils/offline'

/**
 * 中央消去指示(0011)の apply 判定(端末側)。
 *
 * 「中央」= Supabase DB。データセット(sync_sources)の purge_epoch が取り込み時のメタの epoch より
 * 大きければ、イベント終了の指示が出ている = **そのデータセットの端末コピーを捨てる**
 * (`offlinePurgeSource`: items 行・メタ・その source のキュー氏名・ページ缓存)。
 * epoch は単調増加なので何度読んでも同じ結果(idempotent・replay 安全)。
 *
 * 通信失敗は false(消去は「通信したとき opportunist に apply」。次回通信で再 apply される)。
 * 呼び出し点: /scan の mount(ミラー状態を読む前)・flush / ためた記録の確定後(通信のタイミング)。
 */
export async function checkDevicePurge(): Promise<boolean> {
  if (!import.meta.client) return false
  const meta: OfflineMeta | null = readOfflineMetaFromStorage() ?? (await offlineReadMeta().catch(() => null))
  if (!meta || !meta.enabled) return false
  let epochs: Record<number, number>
  try {
    const res = await $fetch<{ epochs?: Record<number, number> }>('/api/purge-state')
    epochs = res.epochs ?? {}
  } catch {
    return false // 通信が無い・失敗: 指示は読めない(次の通信で apply)
  }
  const current = epochs[meta.sourceId] ?? 0
  if (current <= (meta.purgeEpoch ?? 0)) return false
  try {
    await offlinePurgeSource(meta.sourceId)
    return true
  } catch {
    return false // IDB 側失敗は保守側で「まだ残っている」扱い(次回の apply で再試行)
  }
}
