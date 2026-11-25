import { readBody } from 'h3'
import { normalizeScanModes, type ScanConfigResponse, type ScanMode } from '#shared/utils/scan'
import { readServiceAccountKey } from '../utils/googleSheets'
import { loadScanModes, readSheetHeaders, saveScanModes } from '../utils/scanRun'
import { findSourceOrNull, firstSource, loadSources } from '../utils/syncRun'

/**
 * 記録モードの保存(追加・更新・削除)。登録済みユーザのみ。
 * 送られたリストが正 = リストに無い id の行は削除される(動的増減)。id 無しは新規 insert。
 * 入力は normalizeScanModes で正規化する(不正カラム名・空名・action 0 は項目単位で補正し throw しない)。
 * 各モードは sourceId(データセット)を持つことを要求する(saveScanModes が 400 にする)。
 * 記録履歴(scan_events)を持つモードの削除は 400 にする(証跡を残す設計)。
 * 応答は GET と同じ形(正規化後のリスト + データセット一覧 + 対象シートのヘッダー状況)。
 */
export default defineEventHandler(async (event): Promise<ScanConfigResponse> => {
  const { user } = await requireRegisteredUser(event)

  const body = await readBody<{ modes?: unknown; sourceId?: unknown }>(event)
  if (!body || typeof body !== 'object' || !Array.isArray(body.modes)) {
    throw createError({ statusCode: 400, statusMessage: 'modes のリストが必要です' })
  }
  const modes = normalizeScanModes(body.modes)

  const saved = await saveScanModes(event, modes, user.email ?? null)

  const sources = await loadSources(event).then((r) => r.sources).catch(() => [])
  const askedId = typeof body.sourceId === 'number' ? body.sourceId : Number(body.sourceId ?? NaN)
  const target = Number.isInteger(askedId) && askedId > 0
    ? await findSourceOrNull(event, askedId)
    : await firstSource(event).catch(() => null)
  const sheet = await readSheetHeaders(event, target)

  return {
    modes: saved.modes as ScanMode[],
    sources,
    serviceAccountConfigured: (await readServiceAccountKey()) !== null,
    rowMissing: false,
    sourceMissing: Number.isInteger(askedId) && askedId > 0 && target === null,
    sheetTitle: sheet?.title ?? null,
    sheetHeaders: sheet?.headers ?? null,
  }
})