import { readBody } from 'h3'
import { parseRegistrationCode } from '#shared/utils/registration'
import { SCAN_CODE_MAX_LENGTH, SCAN_CODES_MAX, type ScanFlushResponse } from '#shared/utils/scan'
import { flushScan, findScanMode, type ScanFlushInput } from '../utils/scanRun'
import { loadSyncSettings } from '../utils/syncRun'

/**
 * 記録の確定(シートへの書き込み + items payload 反映 + 証跡 scan_events)。登録済みユーザのみ。
 *
 * 連続スキャンの「書き込みを確定」/自動flush(5件)から叩く。
 * codes は文字列 or `{ code, overwrite }` のどちらでも受け取る(確認モードの「上書き」は overwrite: true)。
 * 書き込み順は remark-update と同じ「シート → items payload」。payload 更新だけが失敗すると
 * dbUpdated: false を返す(シートは保存済みなので次の同期で一致する)。
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
    const code = typeof item === 'string' ? item : typeof (item as { code?: unknown })?.code === 'string' ? String((item as { code: string }).code) : ''
    const trimmed = code.trim()
    if (!trimmed || trimmed.length > SCAN_CODE_MAX_LENGTH) continue
    if (parseRegistrationCode(trimmed)) continue // 利用者登録QRは記録しない(黙って全件を消さないように here で除く)
    inputs.push({ code: trimmed, overwrite: (item as { overwrite?: unknown })?.overwrite === true })
    if (inputs.length >= SCAN_CODES_MAX) break
  }
  if (inputs.length === 0) {
    throw createError({ statusCode: 400, statusMessage: '記録する code がありません(すべて不正または登録QR)' })
  }

  const mode = await findScanMode(event, modeId)
  const { settings } = await loadSyncSettings(event)
  const flushed = await flushScan(event, mode, settings, user.email ?? null, inputs)

  return {
    modeId,
    sheetTitle: flushed.sheetTitle,
    results: flushed.results,
    wrote: flushed.wrote,
    dbUpdated: flushed.dbUpdated,
  }
})
