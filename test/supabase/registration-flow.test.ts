/**
 * 認証登録フローの統合テスト(参考: slack2mail の test/supabase/login-to-top-flow)。
 * ローカル Supabase + schema.sql 適用を前提とし、env がなければ自動スキップする。
 *
 * 前提: `supabase start` と SQL Editor(schema.sql)適用済み。
 * 実行: SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY を env に与えて npm test。
 * 注: OAuth のブラウザフローは再現できないため、
 *   admin.auth.admin.createUser(email_confirm: true) + signInWithPassword で
 *   「検証済み email のログイン」を再現し、callback が呼ぶ RPC を直接叩く。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL ?? 'http://localhost:54321'
const PUB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NUXT_PUBLIC_SUPABASE_KEY ?? ''
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.NUXT_SUPABASE_SERVICE_ROLE ?? ''

// env がなければスキップ(CI でローカル Supabase がない環境でも npm test は通る)
const describeFlow = describe.skipIf(!PUB_KEY || !SECRET_KEY)

const TEST_EMAIL = 'flow_test@example.com'
const UNREG_EMAIL = 'unregistered_flow@example.com'
const TEST_PASSWORD = 'test-password-12345'
const TEST_CODE = 'flow-test-code'

let admin: SupabaseClient
let authUserId: string | null = null
let unregUserId: string | null = null

async function signInAs(email: string): Promise<SupabaseClient> {
  const user = createClient(URL, PUB_KEY)
  const { error } = await user.auth.signInWithPassword({ email, password: TEST_PASSWORD })
  expect(error).toBeNull()
  return user
}

describeFlow('email事前登録 → 初回ログイン紐付け → items照会(RLS)', () => {
  beforeAll(async () => {
    admin = createClient(URL, SECRET_KEY)
    // 前回テストの残りを掃除
    await admin.from('users').delete().eq('email', TEST_EMAIL)
    await admin.from('users').delete().eq('email', UNREG_EMAIL)
    await admin.from('items').delete().eq('code', TEST_CODE)
    const { data: list } = await admin.auth.admin.listUsers()
    for (const u of list?.users ?? []) {
      if (u.email === TEST_EMAIL || u.email === UNREG_EMAIL) {
        await admin.auth.admin.deleteUser(u.id)
      }
    }
    authUserId = null
    unregUserId = null
  })

  it('事前登録は auth_user_id 未紐付け(NULL)で作られる(UUID事前照会不要)', async () => {
    const { error } = await admin
      .from('users')
      .insert({ email: TEST_EMAIL, name: 'flow test' })
    expect(error).toBeNull()

    const { data: row } = await admin
      .from('users')
      .select('auth_user_id')
      .eq('email', TEST_EMAIL)
      .maybeSingle()
    expect(row?.auth_user_id).toBeNull()
  })

  it('初回ログイン相当: link_my_user() が検証済みemail一致の行を自動紐付けする', async () => {
    const { data: created, error } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    })
    expect(error).toBeNull()
    authUserId = created!.user!.id

    const user = await signInAs(TEST_EMAIL)
    const { error: linkError } = await user.rpc('link_my_user')
    expect(linkError).toBeNull()

    // 自分の紐付け行のみ見える(RLS users_self_select)
    const { data: row } = await user.from('users').select('auth_user_id, email').maybeSingle()
    expect(row?.auth_user_id).toBe(authUserId)

    const { data: registered } = await user.rpc('is_registered_user')
    expect(registered).toBe(true)
  })

  it('紐付け済みユーザは items を閲覧できる(RLS is_registered_user)', async () => {
    await admin.from('items').upsert({ code: TEST_CODE, payload: { label: 'flow' } })

    const user = await signInAs(TEST_EMAIL)
    const { data } = await user.from('items').select('*').eq('code', TEST_CODE).maybeSingle()
    expect(data?.code).toBe(TEST_CODE)
  })

  it('未紐付けユーザは items・自分のusers行も閲覧できず、is_registered_user は false', async () => {
    const { data: created, error } = await admin.auth.admin.createUser({
      email: UNREG_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    })
    expect(error).toBeNull()
    unregUserId = created!.user!.id

    const user = await signInAs(UNREG_EMAIL)

    const { data: items } = await user.from('items').select('*').eq('code', TEST_CODE).maybeSingle()
    expect(items).toBeNull()

    const { data: users } = await user.from('users').select('*')
    expect(users).toEqual([])

    const { data: registered } = await user.rpc('is_registered_user')
    expect(registered).toBe(false)

    // link_my_user を呼んでも(UNREG_EMAIL の事前登録行がないので)紐付けされない
    await user.rpc('link_my_user')
    const { data: stillUnlinked } = await admin
      .from('users')
      .select('auth_user_id')
      .eq('email', UNREG_EMAIL)
      .maybeSingle()
    expect(stillUnlinked).toBeNull()
  })

  afterAll(async () => {
    if (authUserId) await admin.auth.admin.deleteUser(authUserId)
    if (unregUserId) await admin.auth.admin.deleteUser(unregUserId)
    await admin.from('users').delete().eq('email', TEST_EMAIL)
    await admin.from('users').delete().eq('email', UNREG_EMAIL)
    await admin.from('items').delete().eq('code', TEST_CODE)
  })
})
