/**
 * QR コードの値で items テーブルを照会する。
 * 前提: Google 認証済み + users テーブルへの紐付け。
 * 判定は server/utils/authguard(requireRegisteredUser)に集約し、
 * RLS の is_registered_user() と同じ根で確認する(session+users 二重照会の重複を撤去)。
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

  return {
    found: data != null,
    code,
    row: data,
  }
})
