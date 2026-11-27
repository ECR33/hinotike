/**
 * ログイン権限のリボーク(0012)の統合テスト。
 * ローカル Supabase + マイグレーション(0001..0012)適用を前提とし、env がなければ自動スキップする。
 *
 * 押さえる点:
 * - list_users/revoke_user/restore_user は can_purge の利用者だけ(forbidden)
 * - revoke → is_registered_user() が false(全 RLS・guard が即時に拒否)
 * - 自分のリボークは forbidden_self(ロックアウト事故防止)
 * - revoke_user は revoked_at + revoked_by を立て、already_revoked / not_found を返す
 * - restore → is_registered_user() が true(スナップショットはそのまま)
 * - リボーク後に link_my_user で自動復活しない / QR 承認(approve)では再許可(un-revoke)される
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL ?? 'http://localhost:54321'
const PUB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NUXT_PUBLIC_SUPABASE_KEY ?? ''
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.NUXT_SUPABASE_SERVICE_ROLE ?? ''

const describeFlow = describe.skipIf(!PUB_KEY || !SECRET_KEY)

const SUPER_EMAIL = 'revoke_super@example.com'
const MEMBER_EMAIL = 'revoke_member@example.com'
const OUTSIDER_EMAIL = 'revoke_outsider@example.com'
const TEST_PASSWORD = 'test-password-12345'

let admin: SupabaseClient
let superClient: SupabaseClient
let memberClient: SupabaseClient

async function signInAs(email: string): Promise<SupabaseClient> {
  const user = createClient(URL, PUB_KEY)
  const { error } = await user.auth.signInWithPassword({ email, password: TEST_PASSWORD })
  expect(error).toBeNull()
  return user
}

async function deleteAuthUser(email: string): Promise<void> {
  const { data: list } = await admin.auth.admin.listUsers()
  for (const u of list?.users ?? []) {
    if (u.email === email) await admin.auth.admin.deleteUser(u.id)
  }
}

async function createLinkedUser(email: string, canPurge: boolean): Promise<SupabaseClient> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  })
  expect(error).toBeNull()
  await admin
    .from('users')
    .insert({ email, name: email.split('@')[0], can_purge: canPurge })
  const client = await signInAs(email)
  expect((await client.rpc('link_my_user')).error).toBeNull()
  return client
}

describeFlow('リボーク: can_purge ガード → is_registered_user false → restore → QR再許可', () => {
  beforeAll(async () => {
    admin = createClient(URL, SECRET_KEY)
    await admin.from('users').delete().eq('email', SUPER_EMAIL)
    await admin.from('users').delete().eq('email', MEMBER_EMAIL)
    await admin.from('users').delete().eq('email', OUTSIDER_EMAIL)
    await deleteAuthUser(SUPER_EMAIL)
    await deleteAuthUser(MEMBER_EMAIL)
    await deleteAuthUser(OUTSIDER_EMAIL)

    superClient = await createLinkedUser(SUPER_EMAIL, true)
    memberClient = await createLinkedUser(MEMBER_EMAIL, false)
    // 認証のみ・未登録のユーザ(not_found 側を確認する)
    await admin.auth.admin.createUser({ email: OUTSIDER_EMAIL, password: TEST_PASSWORD, email_confirm: true })
  })

  it('list_users は can_purge の利用者だけ(一覧にスナップショットと can_purge を載せる)', async () => {
    const { data, error } = await superClient.rpc('list_users')
    expect(error).toBeNull()
    const res = data as { status: string; users: { email: string; can_purge: boolean }[] }
    expect(res.status).toBe('ok')
    expect(res.users.map((u) => u.email)).toContain(MEMBER_EMAIL)
    expect(res.users.find((u) => u.email === SUPER_EMAIL)?.can_purge).toBe(true)

    const memberList = await memberClient.rpc('list_users')
    expect((memberList.data as { status: string }).status).toBe('forbidden')
  })

  it('revoke_user でログイン権が切れる(is_registered_user false / revoked_by 監査)', async () => {
    const { data, error } = await superClient.rpc('revoke_user', { p_email: MEMBER_EMAIL })
    expect(error).toBeNull()
    expect((data as { status: string }).status).toBe('ok')

    const { data: registered } = await memberClient.rpc('is_registered_user')
    expect(registered).toBe(false)

    const { data: row } = await admin.from('users').select('revoked_at, revoked_by').eq('email', MEMBER_EMAIL).single()
    expect(row?.revoked_at).not.toBeNull()
    expect(row?.revoked_by).not.toBeNull()

    // 二度目は already_revoked
    const again = await superClient.rpc('revoke_user', { p_email: MEMBER_EMAIL })
    expect((again.data as { status: string }).status).toBe('already_revoked')
  })

  it('自分のリボークは forbidden_self / 未登録の email は not_found', async () => {
    const self = await superClient.rpc('revoke_user', { p_email: SUPER_EMAIL })
    expect((self.data as { status: string }).status).toBe('forbidden_self')

    const outsider = await superClient.rpc('revoke_user', { p_email: OUTSIDER_EMAIL })
    expect((outsider.data as { status: string }).status).toBe('not_found')
  })

  it('リボーク後に link_my_user で自動復活しない(再許可は承認 or restore のみ)', async () => {
    await memberClient.rpc('link_my_user')
    const { data: registered } = await memberClient.rpc('is_registered_user')
    expect(registered).toBe(false)
  })

  it('restore で復活(is_registered_user true / revoked_by も戻る)', async () => {
    const { data, error } = await superClient.rpc('restore_user', { p_email: MEMBER_EMAIL })
    expect(error).toBeNull()
    expect((data as { status: string }).status).toBe('ok')

    const { data: registered } = await memberClient.rpc('is_registered_user')
    expect(registered).toBe(true)

    const { data: row } = await admin.from('users').select('revoked_at, revoked_by').eq('email', MEMBER_EMAIL).single()
    expect(row?.revoked_at).toBeNull()
    expect(row?.revoked_by).toBeNull()

    // リボークされていない行の restore は not_revoked
    const noop = await superClient.rpc('restore_user', { p_email: MEMBER_EMAIL })
    expect((noop.data as { status: string }).status).toBe('not_revoked')
  })

  it('QR 承認でリボーク済み行を再許可できる(un-revoke。email_taken にしない)', async () => {
    await superClient.rpc('revoke_user', { p_email: MEMBER_EMAIL })

    // リボークされた利用者自身が許可依頼を作成できる(is_registered_user false の扱い)
    const req = await memberClient.rpc('create_registration_request')
    const nonce = (req.data as { status: string; nonce: string }).nonce
    expect((req.data as { status: string }).status).toBe('ok')

    const preview = await superClient.rpc('preview_registration_request', { req_nonce: nonce })
    expect((preview.data as { status: string }).status).toBe('ok')

    const approve = await superClient.rpc('approve_registration_request', { req_nonce: nonce })
    expect((approve.data as { status: string }).status).toBe('ok')

    const { data: registered } = await memberClient.rpc('is_registered_user')
    expect(registered).toBe(true)
    const { data: row } = await admin.from('users').select('revoked_at').eq('email', MEMBER_EMAIL).single()
    expect(row?.revoked_at).toBeNull()
  })

  afterAll(async () => {
    for (const email of [SUPER_EMAIL, MEMBER_EMAIL, OUTSIDER_EMAIL]) {
      await deleteAuthUser(email) // auth.users 削除で revoked_by も set null
    }
    await admin.from('users').delete().eq('email', SUPER_EMAIL)
    await admin.from('users').delete().eq('email', MEMBER_EMAIL)
    await admin.from('users').delete().eq('email', OUTSIDER_EMAIL)
  })
})
