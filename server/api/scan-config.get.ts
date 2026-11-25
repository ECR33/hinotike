import type { ScanConfigResponse } from '#shared/utils/scan'
import { readServiceAccountKey } from '../utils/googleSheets'
import { loadScanModes, readSheetHeaders } from '../utils/scanRun'
import { findSourceOrNull, loadSources, firstSource } from '../utils/syncRun'

/**
 * 記録モードの取得 + データセット一覧。登録済みユーザ(requireRegisteredUser)のみ。
 * 設定は DB(public.scan_modes)の行。行が無い場合は既定プリセットを返す(rowMissing=true)。
 * データセット(public.sync_sources の複数行)も一緒に返す(/scan の「どのデータの作業か」の選択の根)。
 * シートの実ヘッダー(sheetHeaders)は ?sourceId= のシートを読む(未指定は有効な最初のシート)。
 * 読み取り失敗は null(モード取得を止めない = lookup と同じ方針)。
 */
export default defineEventHandler(async (event): Promise<ScanConfigResponse> => {
  await requireRegisteredUser(event)

  const query = getQuery(event)
  const askedId = typeof query.sourceId === 'string' ? Number(query.sourceId) : Number(query.sourceId ?? NaN)

  const loaded = await loadScanModes(event)
  const sources = await loadSources(event)
    .then((r) => r.sources)
    .catch(() => [])

  const target = Number.isInteger(askedId) && askedId > 0
    ? await findSourceOrNull(event, askedId)
    : await firstSource(event).catch(() => null)
  const sheet = await readSheetHeaders(event, target)

  return {
    modes: loaded.modes,
    sources,
    serviceAccountConfigured: readServiceAccountKey() !== null,
    rowMissing: loaded.rowMissing,
    sourceMissing: Number.isInteger(askedId) && askedId > 0 && target === null,
    sheetTitle: sheet?.title ?? null,
    sheetHeaders: sheet?.headers ?? null,
  }
})
