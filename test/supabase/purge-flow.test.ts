/**
 * 端末データの中央消去指示(0011)の統合テスト。
 * ローカル Supabase + マイグレーション(0001/0002/.../0011)適用を前提とし、env がなければ自動スキップする。
 *
 * 押さえる点:
 * - can_purge のユーザだけ issue_dataset_purge が通る(他は forbidden、epoch は動かない)
 * - epoch の +1 と監査行(purge_events)
 * - 存在しない data set は not_found
 * - purge_events は登録済みユーザが閲覧可(RLS select)、未登録ユーザには見えない
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL ?? 'http://localhost:54321'
const PUB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NUXT_PUBLIC_SUPABASE_KEY ?? ''
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.NUXT_SUPABASE_SERVICE_ROLE ?? ''

const describeFlow = describe.skipIf(!PUB_KEY || !SECRET_KEY)

const SUPER_EMAIL = 'purge_super@example.com'
const MEMBER_EMAIL = 'purge_member@example.com'
const OUTSIDER_EMAIL = 'purge_outsider@example.com'
const SOURCE_NAME = 'purge-flow-dataset'
const TEST_PASSWORD = 'test-password-12345'

let admin: SupabaseClient
let sourceId: number | null = null

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
  if (canPurge) {
    await admin.from('users').insert({ email, name: email.split('@')[0], can_purge: true })
  } else {
    await admin.from('users').insert({ email, name: email.split('@')[0] })
  }
  const client = await signInAs(email)
  expect((await client.rpc('link_my_user')).error).toBeNull()
  return client
}

describeFlow('中央消去指示: can_purge ガード → epoch +1 → 監査行 → RLS', () => {
  let superClient: SupabaseClient
  let memberClient: SupabaseClient

  beforeAll(async () => {
    admin = createClient(URL, SECRET_KEY)
    await admin.from('users').delete().eq('email', SUPER_EMAIL)
    await admin.from('users').delete().eq('email', MEMBER_EMAIL)
    await admin.from('users').delete().eq('email', OUTSIDER_EMAIL)
    await admin.from('sync_sources').delete().eq('name', SOURCE_NAME)
    await deleteAuthUser(SUPER_EMAIL)
    await deleteAuthUser(MEMBER_EMAIL)
    await deleteAuthUser(OUTSIDER_EMAIL)

    superClient = await createLinkedUser(SUPER_EMAIL, true)
    memberClient = await createLinkedUser(MEMBER_EMAIL, false)
    // 認証のみ・未登録のユーザ(RLS select の deny 側を確認する)
    await admin.auth.admin.createUser({ email: OUTSIDER_EMAIL, password: TEST_PASSWORD, email_confirm: true })

    const { data: created, error } = await admin
      .from('sync_sources')
      .insert({ name: SOURCE_NAME, spreadsheet_id: 'purge-test-sheet', code_column: 'code' })
      .select('id, purge_epoch')
    expect(error).toBeNull()
    sourceId = created?.[0]?.id ?? null
    expect(sourceId).toBeTypeOf('number')
    expect(created?.[0]?.purge_epoch).toBe(0)
  })

  it('can_purge のユーザは指示を出せる(epoch +1 + 監査行)', async () => {
    const { data, error } = await superClient.rpc('issue_dataset_purge', { p_source_id: sourceId! })
    expect(error).toBeNull()
    expect((data as { status: string }).status).toBe('ok')
    expect((data as { purge_epoch: number }).purge_epoch).toBe(1)

    const { data: row } = await admin.from('sync_sources').select('purge_epoch').eq('id', sourceId!).maybeSingle()
    expect(row?.purge_epoch).toBe(1)

    const { data: audit } = await admin
      .from('purge_events')
      .select('source_id, actor_email')
      .eq('source_id', sourceId!)
    expect(audit?.length).toBe(1)
    expect(audit?.[0]?.actor_email).toBe(SUPER_EMAIL)
  })

  it('can_purge のないユーザは forbidden(epoch は動かない)', async () => {
    const { data, error } = await memberClient.rpc('issue_dataset_purge', { p_source_id: sourceId! })
    expect(error).toBeNull()
    expect((data as { status: string }).status).toBe('forbidden')
    const { data: row } = await admin.from('sync_sources').select('purge_epoch').eq('id', sourceId!).maybeSingle()
    expect(row?.purge_epoch).toBe(1)
  })

  it('存在しない data set は not_found', async () => {
    const { data, error } = await superClient.rpc('issue_dataset_purge', { p_source_id: 999999 })
    expect(error).toBeNull()
    expect((data as { status: string }).status).toBe('not_found')
  })

  it('再度の指示で epoch は単調増加(端末側は compare するだけなので idempotent)', async () => {
    const { data } = await superClient.rpc('issue_dataset_purge', { p_source_id: sourceId! })
    expect((data as { purge_epoch: number }).purge_epoch).toBe(2)
  })

  it('purge_events は登録済みユーザが閲覧可 / 未登録ユーザには見えない(RLS select)', async () => {
    const { data: memberSeen } = await memberClient.from('purge_events').select('*').eq('source_id', sourceId!)
    expect(memberSeen?.length).toBe(2)

    const outsider = await signInAs(OUTSIDER_EMAIL) // 認証のみ・未登録
    const { data: outsiderSeen } = await outsider.from('purge_events').select('*').eq('source_id', sourceId!)
    expect(outsiderSeen?.length ?? 0).toBe(0)
  })

  afterAll(async () => {
    for (const email of [SUPER_EMAIL, MEMBER_EMAIL, OUTSIDER_EMAIL]) {
      await deleteAuthUser(email) // auth.users 削除で issued_by も set null
    }
    await admin.from('users').delete().eq('email', SUPER_EMAIL)
    await admin.from('users').delete().eq('email', MEMBER_EMAIL)
    await admin.from('users').delete().eq('email', OUTSIDER_EMAIL)
    await admin.from('purge_events').delete().eq('source_id', sourceId!)
    await admin.from('sync_sources').delete().eq('name', SOURCE_NAME)
  })
})
