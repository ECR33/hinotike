import type { ScanConfigResponse } from '#shared/utils/scan'
import { readServiceAccountKey } from '../utils/googleSheets'
import { loadScanModes, readSheetHeaders } from '../utils/scanRun'
import { loadSyncSettings } from '../utils/syncRun'

/**
 * 記録モードの取得。登録済みユーザ(requireRegisteredUser)のみ。
 * 設定は DB(public.scan_modes)の行。行が無い場合は既定プリセットを返す(rowMissing=true)。
 * シートの取り込みカラム(include_columns)も返す(記録列が取り込み対象に無いときの注記用 —
 * 次回同期は payload を丸ごと書き換えるので、取り込み対象に無い列の記録は payload から消える)。
 * シートの実ヘッダー(sheetHeaders)も返す(設定画面の「シートに列が無い」判定用。読み取り失敗は null)。
 */
export default defineEventHandler(async (event): Promise<ScanConfigResponse> => {
  await requireRegisteredUser(event)

  const loaded = await loadScanModes(event)
  // 取り込みカラムの読み込み失敗はモード取得を止めない(注記だけ出せればよい。lookup と同じ方針)
  const syncSettings = await loadSyncSettings(event)
    .then((r) => r.settings)
    .catch(() => null)
  const sheet = await readSheetHeaders(event, syncSettings)

  return {
    modes: loaded.modes,
    serviceAccountConfigured: readServiceAccountKey() !== null,
    syncIncludeColumns: syncSettings?.includeColumns ?? [],
    rowMissing: loaded.rowMissing,
    sheetTitle: sheet?.title ?? null,
    sheetHeaders: sheet?.headers ?? null,
  }
})
