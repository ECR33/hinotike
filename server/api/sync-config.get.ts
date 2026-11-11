import type { SyncConfigResponse } from '#shared/utils/sync'
import { readServiceAccountKey } from '../utils/googleSheets'

/**
 * 同期設定の取得。登録済みユーザ(requireRegisteredUser)のみ。
 * 設定は DB(public.sync_settings の id=1 行)。行が無い場合は既定値を返す(rowMissing=true)。
 * サービスアカウント鍵の有無も一緒に返す(未設定なら同期実行不可の案内用)。
 */
export default defineEventHandler(async (event): Promise<SyncConfigResponse> => {
  await requireRegisteredUser(event)

  const loaded = await loadSyncSettings(event)
  return {
    settings: loaded.settings,
    serviceAccountConfigured: readServiceAccountKey() !== null,
    updatedBy: loaded.updatedBy,
    updatedAt: loaded.updatedAt,
    rowMissing: loaded.rowMissing,
  }
})
