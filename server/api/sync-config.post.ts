import { readBody } from 'h3'
import { normalizeSources, type SourceConfigResponse, type SyncSource } from '#shared/utils/sync'
import { readServiceAccountKey } from '../utils/googleSheets'
import { saveSources } from '../utils/syncRun'

/**
 * データセット(取り込み定義)の保存(追加・更新・削除)。登録済みユーザのみ。
 * 送られたリストが正 = リストに無い id の行は削除される(動的増減)。id 無しは新規 insert。
 * 入力は normalizeSources で正規化する(不正スプレッドシート ID・空名・重複名は項目単位で補正し throw しない)。
 * spreadsheetId の空文字は保存できる(未設定 = 取り込みは 400 で拒否される)。
 * 記録モード(scan_modes.source_id)が紐づくデータセットの削除は FK の restrict で 400 にする。
 */
export default defineEventHandler(async (event): Promise<SourceConfigResponse> => {
  const { user } = await requireRegisteredUser(event)

  const body = await readBody<{ sources?: unknown }>(event)
  if (!body || typeof body !== 'object' || !Array.isArray(body.sources)) {
    throw createError({ statusCode: 400, statusMessage: 'sources のリストが必要です' })
  }
  const sources = normalizeSources(body.sources)
  if (sources.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'データセットを 1つ以上残してください(すべて削除はできません)' })
  }

  const saved = await saveSources(event, sources, user.email ?? null)

  return {
    sources: saved.sources as SyncSource[],
    serviceAccountConfigured: (await readServiceAccountKey()) !== null,
    updatedBy: user.email ?? null,
    updatedAt: saved.updatedAt,
    rowMissing: false,
  }
})
