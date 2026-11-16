import { readBody } from 'h3'
import { parseRegistrationCode } from '#shared/utils/registration'
import { SCAN_CODE_MAX_LENGTH, type ScanCheckResponse } from '#shared/utils/scan'
import { checkScanCode, findScanMode } from '../utils/scanRun'
import { loadSyncSettings } from '../utils/syncRun'

/**
 * 記録の照合(読み取り専用。書き込まない)。登録済みユーザのみ。
 *
 * 連続スキャンの即時フィードバック用: items 照会 + payload の状態(済/未) + シート行の存在だけを見る。
 * /api/scan-flush が実際に書くので、確認モードの pending card はここで氏名と現在の状態を出す。
 * 利用者登録QR(`hinotike-registration:`)は記録対象ではないので拒否する(黙って not_found にしない)。
 */
export default defineEventHandler(async (event): Promise<ScanCheckResponse> => {
  await requireRegisteredUser(event)

  const body = await readBody<{ modeId?: unknown; code?: unknown }>(event)
  const modeId = typeof body?.modeId === 'number' ? body.modeId : Number(body?.modeId)
  if (!Number.isInteger(modeId)) {
    throw createError({ statusCode: 400, statusMessage: 'modeId が必要です' })
  }
  const code = String(body?.code ?? '').trim()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'code is required' })
  }
  if (code.length > SCAN_CODE_MAX_LENGTH) {
    throw createError({ statusCode: 400, statusMessage: `code は ${SCAN_CODE_MAX_LENGTH} 文字まで` })
  }
  if (parseRegistrationCode(code)) {
    throw createError({ statusCode: 400, statusMessage: '利用者登録用のQRです(記録対象のチケットコードをスキャンしてください)' })
  }

  const mode = await findScanMode(event, modeId)
  const { settings } = await loadSyncSettings(event)
  const checked = await checkScanCode(event, mode, settings, code)

  // 氏名は lookup と同じ根で出す(画面の pending card・セッション欄用)。握りつぶさず DB エラーは 500。
  return {
    modeId,
    code,
    status: checked.status,
    name: checked.name,
    state: checked.state,
    recordedAt: checked.recordedAt,
    at: new Date().toISOString(),
  }
})
