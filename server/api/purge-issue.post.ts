import { readBody } from 'h3'

/**
 * 消去指示の発動(「イベント終了 → このデータセットの端末コピーを消去」)。
 * 権限は RPC 側(`issue_dataset_purge`)の `users.can_purge` ガードが集約する(画面の出し分けは /api/me の canPurge)。
 * 内部メッセージはログに出し、画面には固定の status のみ返す(approval API と同じ方針)。
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ sourceId?: unknown }>(event)
  const sourceId = typeof body?.sourceId === 'number' ? body.sourceId : Number(body?.sourceId)
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'sourceId が必要です' })
  }

  const { supabase } = await requireRegisteredUser(event)
  const { data, error } = await supabase.rpc('issue_dataset_purge', { p_source_id: sourceId })
  if (error) {
    console.error('[purge-issue] rpc:', error.message)
    throw createError({ statusCode: 500, statusMessage: 'purge issue failed' })
  }
  return data as { status: string; source_id?: number; purge_epoch?: number }
})
