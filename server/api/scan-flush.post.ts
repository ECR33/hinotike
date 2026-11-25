import { readBody } from 'h3'
import { parseRegistrationCode } from '#shared/utils/registration'
import { SCAN_CODE_MAX_LENGTH, SCAN_CODES_MAX, type ScanFlushResponse } from '#shared/utils/scan'
import { findSource } from '../utils/syncRun'
import { flushScan, findScanMode, type ScanFlushInput } from '../utils/scanRun'

/**
 * 記録の確定(**シートへの書き込み** + 証跡 scan_events)。登録済みユーザのみ。
 *
 * 連続スキャンの「書き込みを確定」/自動flush(SCAN_AUTO_FLUSH_COUNT)から叩く。
 * 対象シートは mode.sourceId のデータセット(モード = 1データセットに紐づく)。
 * codes は文字列 or `{ code, overwrite, at }` のどちらでも受け取る(確認モードの「上書き」は overwrite: true、
 * ローカルにためた読み取りの確定は `at` = 読み取り日時を送る = シートの日時セルと証跡に載る)。
 * payload 反映はしない(シートが唯一の正。端末ミラーは画面が応答の written を写す)。
 */
export default defineEventHandler(async (event): Promise<ScanFlushResponse> => {
  const { user } = await requireRegisteredUser(event)

  const body = await readBody<{ modeId?: unknown; codes?: unknown }>(event)
  const modeId = typeof body?.modeId === 'number' ? body.modeId : Number(body?.modeId)
  if (!Number.isInteger(modeId)) {
    throw createError({ statusCode: 400, statusMessage: 'modeId が必要です' })
  }
  if (!Array.isArray(body?.codes)) {
    throw createError({ statusCode: 400, statusMessage: 'codes のリストが必要です' })
  }

  const inputs: ScanFlushInput[] = []
  for (const item of body!.codes!) {
    const o = (item && typeof item === 'object' ? item : { code: item }) as { code?: unknown; overwrite?: unknown; at?: unknown }
    const trimmed = String(o.code ?? '').trim()
    if (!trimmed || trimmed.length > SCAN_CODE_MAX_LENGTH) continue
    if (parseRegistrationCode(trimmed)) continue // 利用者登録QRは記録しない(黙って全件を消さないように here で除く)
    inputs.push({
      code: trimmed,
      overwrite: o.overwrite === true,
      at: typeof o.at === 'string' ? o.at : undefined,
    })
    if (inputs.length >= SCAN_CODES_MAX) break
  }
  if (inputs.length === 0) {
    throw createError({ statusCode: 400, statusMessage: '記録する code がありません(すべて不正または登録QR)' })
  }

  const mode = await findScanMode(event, modeId)
  if (mode.sourceId === null) {
    throw createError({ statusCode: 400, statusMessage: `モード "${mode.name}" のデータセットが未指定です(記録の設定でデータセットを選んでください)` })
  }
  const source = await findSource(event, mode.sourceId)
  const flushed = await flushScan(event, mode, source, user.email ?? null, inputs)

  return {
    modeId,
    sheetTitle: flushed.sheetTitle,
    results: flushed.results,
    wrote: flushed.wrote,
    auditWritten: flushed.auditWritten,
  }
})