import { readBody } from 'h3'
import { normalizeScanModes, type ScanConfigResponse, type ScanMode } from '#shared/utils/scan'
import { readServiceAccountKey } from '../utils/googleSheets'
import { saveScanModes, readSheetHeaders } from '../utils/scanRun'
import { loadSyncSettings } from '../utils/syncRun'

/**
 * 記録モードの保存(追加・更新・削除)。登録済みユーザのみ。
 * 送られたリストが正 = リストに無い id の行は削除される(動的増減)。id 無しは新規 insert。
 * 入力は normalizeScanModes で正規化する(不正カラム名・空名・action 0 は項目単位で補正し throw しない)。
 * 記録履歴(scan_events)を持つモードの削除は 400 にする(証跡を残す設計)。
 * 応答は GET と同じ形(正規化後のリスト + シートのヘッダー状況。設定画面がそのまま引き直せる)。
 */
export default defineEventHandler(async (event): Promise<ScanConfigResponse> => {
  const { user } = await requireRegisteredUser(event)

  const body = await readBody<{ modes?: unknown }>(event)
  if (!body || typeof body !== 'object' || !Array.isArray(body.modes)) {
    throw createError({ statusCode: 400, statusMessage: 'modes のリストが必要です' })
  }
  const modes = normalizeScanModes(body.modes)

  const saved = await saveScanModes(event, modes, user.email ?? null)

  const syncSettings = await loadSyncSettings(event)
    .then((r) => r.settings)
    .catch(() => null)
  const sheet = await readSheetHeaders(event, syncSettings)

  return {
    modes: saved.modes as ScanMode[],
    serviceAccountConfigured: readServiceAccountKey() !== null,
    syncIncludeColumns: syncSettings?.includeColumns ?? [],
    rowMissing: false,
    sheetTitle: sheet?.title ?? null,
    sheetHeaders: sheet?.headers ?? null,
  }
})
