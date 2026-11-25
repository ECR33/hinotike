import type { SourceConfigResponse } from '#shared/utils/sync'
import { readServiceAccountKey } from '../utils/googleSheets'
import { loadSources } from '../utils/syncRun'

/**
 * データセット(取り込み定義)の一覧。登録済みユーザ(requireRegisteredUser)のみ。
 * 定義は DB(public.sync_sources の**複数行**)。行が無い場合は既定値を返す(rowMissing=true)。
 * サービスアカウント鍵の有無も一緒に返す(未設定なら取り込み・書き戻し不可の案内用)。
 */
export default defineEventHandler(async (event): Promise<SourceConfigResponse> => {
  await requireRegisteredUser(event)

  const loaded = await loadSources(event)
  return {
    sources: loaded.sources,
    serviceAccountConfigured: (await readServiceAccountKey()) !== null,
    updatedBy: loaded.updatedBy,
    updatedAt: loaded.updatedAt,
    rowMissing: loaded.rowMissing,
  }
})
