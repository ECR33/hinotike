import { serverSupabaseClient } from '#supabase/server'

/**
 * 消去指示の状態(purge_epoch の一覧)。登録済みユーザ(requireRegisteredUser)のみ。
 * 端末は「取り込み時の epoch(メタ)」とこの現在値を比較し、自分の方が古ければそのミラーを捨てる
 * (`app/composables/useDevicePurge.ts`)。epoch は単調増加なので指示の読み取りは idempotent。
 * 読み取り自体は敏感な情報ではない(公開カウンタ)。発動は RPC の can_purge ガードで別途保護する。
 */
export default defineEventHandler(async (event) => {
  const { supabase } = await requireRegisteredUser(event)
  const { data, error } = await supabase.from('sync_sources').select('id, purge_epoch')
  if (error) {
    console.error('[purge-state] sync_sources:', error.message)
    throw createError({ statusCode: 500, statusMessage: 'purge state lookup failed' })
  }
  const epochs: Record<number, number> = {}
  for (const row of data ?? []) {
    if (row.id != null) epochs[row.id] = row.purge_epoch ?? 0
  }
  return { epochs }
})
