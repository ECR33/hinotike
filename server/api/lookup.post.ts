import { productOrderKeys } from '#shared/utils/items'
import { loadSyncSettings } from '../utils/syncRun'

/**
 * QR コードの値で items テーブルを照会する。
 * 前提: Google 認証済み + users テーブルへの紐付け。
 * 判定は server/utils/authguard(requireRegisteredUser)に集約し、
 * RLS の is_registered_user() と同じ根で確認する(session+users 二重照会の重複を撤去)。
 * 商品欄の表示順(productOrder)は同期設定(public.sync_settings の include_columns の並び)から
 * 作る。設定の読み込み失敗は照会自体を止めない([] = 画面側がフォールバックの並びを使う)。
 */
export default defineEventHandler(async (event) => {
  const { supabase } = await requireRegisteredUser(event)

  const body = await readBody<{ code?: unknown }>(event)
  const code = String(body?.code ?? '').trim()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'code is required' })
  }

  const { data, error } = await supabase
    .from('items')
    .select('*')
    .eq('code', code)
    .maybeSingle()

  if (error) {
    console.error('[lookup] items:', error.message)
    throw createError({ statusCode: 500, statusMessage: 'items lookup failed' })
  }

  // 商品表示順(同期設定の include_columns の並び → rename 適用後の個数キー)。失敗しても照会は返す。
  let productOrder: string[] = []
  try {
    const { settings } = await loadSyncSettings(event)
    productOrder = productOrderKeys(settings.includeColumns, settings.rename)
  } catch (e: unknown) {
    console.error('[lookup] sync_settings:', e instanceof Error ? e.message : String(e))
  }

  return {
    found: data != null,
    code,
    row: data,
    productOrder,
  }
})
