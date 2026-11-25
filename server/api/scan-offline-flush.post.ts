import { readBody } from 'h3'
import { normalizeOfflineEntries, OFFLINE_FLUSH_MAX, type OfflineFlushInput, type OfflineFlushResponse, type OfflineFlushResultEntry } from '#shared/utils/offline'
import { SCAN_CODES_MAX, type ScanStatus } from '#shared/utils/scan'
import { flushScan, findScanMode, type ScanFlushInput } from '../utils/scanRun'
import { findSource } from '../utils/syncRun'

/**
 * ローカル記録の復旧確定(端末にためた読み取りをまとめてシートへ書く)。登録済みユーザのみ。
 * 書き込み順は scan-flush と同じ(**シートへ書く** + 証跡 scan_events)。payload 反映はしない。
 *
 * body は `{ entries: [{ modeId, code, at, overwrite }] }`。
 * - `at` は読み取り時刻(ISO)。シートの日時セルと証跡の at にそのまま載る(不正は確定時刻にフォールバック)。
 * - modeId でグループ化して 1モードごとに flushScan を実行する(1リクエストで複数モードのキューを確定できる)。
 *   対象シートは各モードの sourceId(モードが消されていれば 400 = 画面側はキューを保持して再確定できる)。
 * - その行が既に「済」になっていた場合は flushScan の dedupe 既存動作で書き込まない
 *   (duplicate / skipped を返す。画面は「既に済だった N件」として注記を出す)。
 * - sheet_missing / not_found はここで初めて確定する(ローカル check は payload を鏡として扱うので判定できない)。
 * - 1リクエストの上限 OFFLINE_FLUSH_MAX、1モード group の chunk は画面側が SCAN_CODES_MAX に分割して送る。
 */
export default defineEventHandler(async (event): Promise<OfflineFlushResponse> => {
  const { user } = await requireRegisteredUser(event)

  const body = await readBody<{ entries?: unknown }>(event)
  const inputs = normalizeOfflineEntries(body?.entries, OFFLINE_FLUSH_MAX)
  if (inputs.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'entries のリストが必要です(すべて不正または登録QR)', data: { max: OFFLINE_FLUSH_MAX } })
  }

  // modeId でグループ化(挿入順を保持する。1グループ = 1 flushScan = 1バッチ書き込み)。
  const groups = new Map<number, OfflineFlushInput[]>()
  for (const input of inputs) {
    const part = groups.get(input.modeId)
    if (part) part.push(input)
    else groups.set(input.modeId, [input])
  }

  const actorEmail = user.email ?? null

  const results: OfflineFlushResultEntry[] = []
  let wrote = 0
  let skipped = 0
  let auditWritten = true
  let sheetTitle = ''

  for (const [modeId, part] of groups) {
    // モードが削除された・列が欠ける場合は 400 がそのまま上がる(画面側はキューを保持して再確定できる)
    const mode = await findScanMode(event, modeId)
    if (mode.sourceId === null) {
      throw createError({ statusCode: 400, statusMessage: `モード "${mode.name}" のデータセットが未指定です(記録の設定でデータセットを選んでください)` })
    }
    const source = await findSource(event, mode.sourceId)
    const flushed = await flushScan(event, mode, source, actorEmail, part.slice(0, SCAN_CODES_MAX) as ScanFlushInput[])
    for (const r of flushed.results) results.push({ ...r, modeId })
    wrote += flushed.wrote
    skipped += flushed.results.filter((r) => r.status === 'duplicate' || r.status === 'skipped').length
    auditWritten = auditWritten && flushed.auditWritten
    if (flushed.sheetTitle) sheetTitle = flushed.sheetTitle
  }

  // 送られたのに results に出ていない entry(上限超過で黙って切られたぶん)は status で不明にならないように
  // write_failed を添えて返す(画面側はキューを保持して再確定できる)。
  const returned = new Set(results.map((r) => `${r.modeId}|${r.code}`))
  for (const input of inputs) {
    if (returned.has(`${input.modeId}|${input.code}`)) continue
    results.push({ modeId: input.modeId, code: input.code, status: 'write_failed' as ScanStatus, name: null, written: {}, range: null, at: input.at })
  }

  return { results, wrote, skipped, auditWritten, sheetTitle }
})