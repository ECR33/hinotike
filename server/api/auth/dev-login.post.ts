import { serverSupabaseClient } from '#supabase/server'

/**
 * dev モード限定のパスワードログイン(ローカル Supabase での UI 検証用)。
 * Google OAuth はローカル gotrue がサードパーティプロバイダ非対応のため使えない。
 * 本番ビルド(NODE_ENV=production)では常に 404。
 */
export default defineEventHandler(async (event) => {
  // dev モード + ローカル Supabase の URL のときだけ有効。
  // hosted Supabase を指す dev(隧道テスト)ではホスト版にdevユーザが存在しないので 404。
  const supabaseUrl = String((useRuntimeConfig(event).public?.supabase ?? {}).url ?? '')
  const isLocalSupabase = /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?$/i.test(supabaseUrl)
  if (process.env.NODE_ENV === 'production' || !isLocalSupabase) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  if (!isSupabaseConfigured(event)) {
    throw createError({ statusCode: 500, statusMessage: 'Supabase が設定されていません' })
  }

  const body = await readBody<{ email?: unknown; password?: unknown }>(event)
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!email || !password) {
    throw createError({ statusCode: 400, statusMessage: 'email と password が必要です' })
  }

  const supabase = await serverSupabaseClient(event)
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    console.error('[dev-login] sign-in failed:', error.message)
    throw createError({ statusCode: 401, statusMessage: 'dev ログインに失敗しました(email/password を確認してください)' })
  }

  // OAuth callback と同じ自動紐付け(dev では毎回呼ぶ。冪等)。
  const { error: linkError } = await supabase.rpc('link_my_user')
  if (linkError) console.error('[dev-login] link_my_user:', linkError.message)

  return { ok: true }
})
