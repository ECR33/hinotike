/**
 * QRによる利用者許可フローの統合テスト。
 * ローカル Supabase + マイグレーション(0001/0002)適用を前提とし、env がなければ自動スキップする。
 *
 * 注: OAuth のブラウザフローは再現できないため、
 *   admin.auth.admin.createUser(email_confirm: true) + signInWithPassword で
 *   「検証済み email のログイン」を再現し、API の代わりに RPC を直接叩く
 *   (server API は RPC を呼ぶだけの薄いラッパー)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL ?? 'http://localhost:54321'
const PUB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NUXT_PUBLIC_SUPABASE_KEY ?? ''
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.NUXT_SUPABASE_SERVICE_ROLE ?? ''

const describeFlow = describe.skipIf(!PUB_KEY || !SECRET_KEY)

const APPROVER_EMAIL = 'qr_approver@example.com'
const REQUESTER_EMAIL = 'qr_requester@example.com'
const DOMAIN_EMAIL = 'qr_domain@other.example'
const TEST_PASSWORD = 'test-password-12345'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let admin: SupabaseClient
let approverId: string | null = null
let requesterId: string | null = null
let domainUserId: string | null = null
let approvedNonce: string | null = null

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

async function createAuthUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  })
  expect(error).toBeNull()
  return data!.user!.id
}

describeFlow('QR許可: 依頼作成 → preview → approve → 登録 / 再利用拒否', () => {
  beforeAll(async () => {
    admin = createClient(URL, SECRET_KEY)
    await admin.from('users').delete().eq('email', APPROVER_EMAIL)
    await admin.from('users').delete().eq('email', REQUESTER_EMAIL)
    await admin.from('users').delete().eq('email', DOMAIN_EMAIL)
    await admin.from('user_email_domains').delete().eq('domain', 'allowed.example')
    await deleteAuthUser(APPROVER_EMAIL)
    await deleteAuthUser(REQUESTER_EMAIL)
    await deleteAuthUser(DOMAIN_EMAIL)

    // 許可者(既存の登録済み利用者): 事前登録行 + 紐付け
    approverId = await createAuthUser(APPROVER_EMAIL)
    await admin.from('users').insert({ email: APPROVER_EMAIL, name: 'approver' })
    const approver = await signInAs(APPROVER_EMAIL)
    expect((await approver.rpc('link_my_user')).error).toBeNull()

    requesterId = null
    domainUserId = null
  })

  it('未登録の認証ユーザは依頼を作成できる(nonce + 有効期限)', async () => {
    requesterId = await createAuthUser(REQUESTER_EMAIL)
    const requester = await signInAs(REQUESTER_EMAIL)

    const { data, error } = await requester.rpc('create_registration_request')
    expect(error).toBeNull()
    expect((data as { status: string }).status).toBe('ok')
    const nonce = (data as { nonce: string }).nonce
    expect(nonce).toMatch(UUID_RE)
    expect((data as { expires_at: string }).expires_at).toBeTruthy()

    // 依頼行は依頼者本人のみ閲覧可(RLS owner_select)。別の未登録ユーザからは見えない
    const otherId = await createAuthUser('qr_other_unregistered@example.com')
    const otherClient = await signInAs('qr_other_unregistered@example.com')
    const { data: rows } = await otherClient.from('registration_requests').select('*')
    expect(rows).toEqual([])
    await admin.auth.admin.deleteUser(otherId)
  })

  it('未登録ユーザは preview/approve を呼べない(forbidden)', async () => {
    const requester = await signInAs(REQUESTER_EMAIL)
    const { data: made } = await requester.rpc('create_registration_request')
    const nonce = (made as { nonce: string }).nonce

    const { data: preview } = await requester.rpc('preview_registration_request', { req_nonce: nonce })
    expect((preview as { status: string }).status).toBe('forbidden')
    const { data: approve } = await requester.rpc('approve_registration_request', { req_nonce: nonce })
    expect((approve as { status: string }).status).toBe('forbidden')
  })

  it('再生成で古い nonce は無効化される(依頼は1人1行)', async () => {
    const requester = await signInAs(REQUESTER_EMAIL)
    const { data: old } = await requester.rpc('create_registration_request')
    const oldNonce = (old as { nonce: string }).nonce
    const { data: fresh } = await requester.rpc('create_registration_request')
    const freshNonce = (fresh as { nonce: string }).nonce
    expect(freshNonce).not.toBe(oldNonce)

    const approver = await signInAs(APPROVER_EMAIL)
    const { data: stale } = await approver.rpc('preview_registration_request', { req_nonce: oldNonce })
    expect((stale as { status: string }).status).toBe('not_found')
    const { data: ok } = await approver.rpc('preview_registration_request', { req_nonce: freshNonce })
    expect((ok as { status: string }).status).toBe('ok')
    expect((ok as { email: string }).email).toBe(REQUESTER_EMAIL)
  })

  it('approve で users に紐付けられ、依頼者が登録済みになる', async () => {
    const requester = await signInAs(REQUESTER_EMAIL)
    const { data: made } = await requester.rpc('create_registration_request')
    approvedNonce = (made as { nonce: string }).nonce

    const approver = await signInAs(APPROVER_EMAIL)
    const { data: res, error } = await approver.rpc('approve_registration_request', { req_nonce: approvedNonce })
    expect(error).toBeNull()
    expect((res as { status: string }).status).toBe('ok')

    const { data: row } = await admin
      .from('users')
      .select('auth_user_id, email, linked_at')
      .eq('email', REQUESTER_EMAIL)
      .maybeSingle()
    expect(row?.auth_user_id).toBe(requesterId)
    expect(row?.linked_at).toBeTruthy()

    const { data: registered } = await requester.rpc('is_registered_user')
    expect(registered).toBe(true)

    // 監査: consumed_at / approved_by が記録されている
    const { data: req } = await admin
      .from('registration_requests')
      .select('consumed_at, approved_by')
      .eq('nonce', approvedNonce)
      .maybeSingle()
    expect(req?.consumed_at).toBeTruthy()
    expect(req?.approved_by).toBe(approverId)
  })

  it('消費済みのQRの再利用は consumed、登録済みの依頼者の再依頼は already_registered', async () => {
    expect(approvedNonce).toBeTruthy()
    const approver = await signInAs(APPROVER_EMAIL)
    const { data: res } = await approver.rpc('approve_registration_request', { req_nonce: approvedNonce })
    expect((res as { status: string }).status).toBe('consumed')

    // 依頼者はすでに登録済み → 依頼行は作られない(create は already_registered)
    const requester = await signInAs(REQUESTER_EMAIL)
    const { data: again } = await requester.rpc('create_registration_request')
    expect((again as { status: string }).status).toBe('already_registered')
  })

  it('存在しない nonce は not_found( forged QR は DB に依頼行が無いので使えない)', async () => {
    const approver = await signInAs(APPROVER_EMAIL)
    const forged = '00000000-0000-4000-8000-000000000000'
    const { data: res } = await approver.rpc('approve_registration_request', { req_nonce: forged })
    expect((res as { status: string }).status).toBe('not_found')
  })

  it('ドメイン制限: 許可ドメイン外の依頼は preview/approve で domain_not_allowed', async () => {
    // 許可リストに他のドメインだけ置くと、other.example の依頼は拒否される
    await admin.from('user_email_domains').insert({ domain: 'allowed.example' })

    domainUserId = await createAuthUser(DOMAIN_EMAIL)
    const domainUser = await signInAs(DOMAIN_EMAIL)
    const { data: made } = await domainUser.rpc('create_registration_request')
    const nonce = (made as { nonce: string }).nonce

    const approver = await signInAs(APPROVER_EMAIL)
    const { data: p } = await approver.rpc('preview_registration_request', { req_nonce: nonce })
    expect((p as { status: string }).status).toBe('domain_not_allowed')
    const { data: a } = await approver.rpc('approve_registration_request', { req_nonce: nonce })
    expect((a as { status: string }).status).toBe('domain_not_allowed')
    await admin.from('user_email_domains').delete().eq('domain', 'allowed.example')

    // ドメイン制限を解除(0行=全許可)すると許可できる
    const { data: p2 } = await approver.rpc('preview_registration_request', { req_nonce: nonce })
    expect((p2 as { status: string }).status).toBe('ok')
    const { data: a2 } = await approver.rpc('approve_registration_request', { req_nonce: nonce })
    expect((a2 as { status: string }).status).toBe('ok')
    const { data: registered } = await domainUser.rpc('is_registered_user')
    expect(registered).toBe(true)
  })

  afterAll(async () => {
    for (const email of [APPROVER_EMAIL, REQUESTER_EMAIL, DOMAIN_EMAIL, 'qr_other_unregistered@example.com']) {
      await deleteAuthUser(email) // auth.users 削除で依頼行も cascade で消える
    }
    await admin.from('users').delete().eq('email', APPROVER_EMAIL)
    await admin.from('users').delete().eq('email', REQUESTER_EMAIL)
    await admin.from('users').delete().eq('email', DOMAIN_EMAIL)
    await admin.from('user_email_domains').delete().eq('domain', 'allowed.example')
  })
})
