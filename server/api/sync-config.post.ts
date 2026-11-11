import { readBody } from 'h3'
import { normalizeSettings, type SyncConfigResponse, type SyncSettings } from '#shared/utils/sync'
import { readServiceAccountKey } from '../utils/googleSheets'

/**
 * 同期設定の保存(singleton 行 id=1 の upsert)。登録済みユーザのみ。
 * 入力は normalizeSettings で正規化する(不正なテーブル名/ID は既定値へ補正)。
 * spreadsheetId の空文字は保存できる(未設定 = 同期は 400 で拒否される)。
 */
export default defineEventHandler(async (event): Promise<SyncConfigResponse> => {
  const { user } = await requireRegisteredUser(event)

  const body = await readBody<Partial<SyncSettings>>(event)
  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, statusMessage: '設定本体が必要です' })
  }
  const settings = normalizeSettings(body)

  const { updatedAt } = await saveSyncSettings(event, settings, user.email ?? null)

  return {
    settings,
    serviceAccountConfigured: readServiceAccountKey() !== null,
    updatedBy: user.email ?? null,
    updatedAt,
    rowMissing: false,
  }
})
