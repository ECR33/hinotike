/**
 * スキャンの記録モードと証跡の RLS 統合テスト(doc/docs/scan-modes.md)。
 * ローカル Supabase + マイグレーション(0001〜0006)適用を前提とし、env がなければ自動スキップする。
 *
 * 注: API(server/api/scan-*)はシート書き込み(Google の鍵)を使うのでここでは叩かない。
 *   DB 側の契約(RLS・FK の restrict・分页の seq)をクライアントから直接確認する。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL ?? 'http://localhost:54321'
const PUB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NUXT_PUBLIC_SUPABASE_KEY ?? ''
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.NUXT_SUPABASE_SERVICE_ROLE ?? ''

const describeFlow = describe.skipIf(!PUB_KEY || !SECRET_KEY)

const REGISTERED_EMAIL = 'scan_registered@example.com'
const UNREGISTERED_EMAIL = 'scan_unregistered@example.com'
const TEST_PASSWORD = 'test-password-12345'

const MODE_NAME = 'scan_test_棚卸し'

let admin: SupabaseClient
let registeredId: string | null = null
let unregisteredId: string | null = null

async function signInAs(email: string): Promise<SupabaseClient> {
  const user = createClient(URL, PUB_KEY)
  const { error } = await user.auth.signInWithPassword({ email, password: TEST_PASSWORD })
  expect(error).toBeNull()
  return user
}

async function createAuthUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email, password: TEST_PASSWORD, email_confirm: true })
  expect(error).toBeNull()
  return data!.user!.id
}

/** admin(secret key)で insert した scan_events を掃除する(RLS は authenticated 側だけ)。 */
async function purgeEvents(modeName: string): Promise<void> {
  const { error } = await admin.from('scan_events').delete().eq('mode_name', modeName)
  expect(error).toBeNull()
}

async function purgeMode(name: string): Promise<void> {
  await purgeEvents(name)
  const { error } = await admin.from('scan_modes').delete().eq('name', name)
  expect(error).toBeNull()
}

describeFlow('スキャンの記録: scan_modes の RLS / scan_events の証跡 / モード削除の restrict', () => {
  beforeAll(async () => {
    admin = createClient(URL, SECRET_KEY)
    await purgeMode(MODE_NAME)
    await admin.from('users').delete().eq('email', REGISTERED_EMAIL)
    await admin.from('users').delete().eq('email', UNREGISTERED_EMAIL)
    registeredId = await createAuthUser(REGISTERED_EMAIL)
    unregisteredId = await createAuthUser(UNREGISTERED_EMAIL)
    // users 行は admin で作る(登録済みの定義 = users に紐付け行があること)。link_my_user は API 側。
    const { error: insErr } = await admin.from('users').insert({ email: REGISTERED_EMAIL, auth_user_id: registeredId, name: 'スキャンテスト' })
    expect(insErr).toBeNull()
  })

  afterAll(async () => {
    if (admin) {
      await purgeMode(MODE_NAME)
      await admin.from('users').delete().eq('email', REGISTERED_EMAIL)
      await admin.from('users').delete().eq('email', UNREGISTERED_EMAIL)
      if (registeredId) await admin.auth.admin.deleteUser(registeredId)
      if (unregisteredId) await admin.auth.admin.deleteUser(unregisteredId)
    }
  })

  it('既定プリセットの2モードが載っている(配布=連続 / チェックイン=確認)', async () => {
    const user = await signInAs(REGISTERED_EMAIL)
    const { data, error } = await user.from('scan_modes').select('id, name, actions, dedupe, confirm_before_record').order('id')
    expect(error).toBeNull()
    const distribute = data?.find((m) => m.name === 'チケット配布')
    const checkin = data?.find((m) => m.name === 'チェックイン')
    expect(distribute?.confirm_before_record).toBe(false)
    expect(checkin?.confirm_before_record).toBe(true)
    expect((checkin?.actions as Array<Record<string, unknown>>)[0]?.column).toBe('来場済')
    expect((checkin?.actions as Array<Record<string, unknown>>)[0]?.column_at).toBe('来場日時')
  })

  it('登録済みユーザはモードを増やせる(動的増減)', async () => {
    const user = await signInAs(REGISTERED_EMAIL)
    const { data, error } = await user
      .from('scan_modes')
      .insert({
        name: MODE_NAME,
        actions: [{ column: '棚卸済', column_at: '棚卸日時', literal: '済', payload_key: '棚卸済', payload_at_key: '棚卸日時' }],
        dedupe: 'skip',
        confirm_before_record: false,
        require_found: true,
        enabled: true,
      })
      .select('id, name')
      .single()
    expect(error).toBeNull()
    expect(data?.name).toBe(MODE_NAME)

    // 更新(無効化)も同じ権限で通る
    const { error: updErr } = await user.from('scan_modes').update({ enabled: false }).eq('id', data!.id)
    expect(updErr).toBeNull()
    const { data: after } = await user.from('scan_modes').select('enabled').eq('id', data!.id).single()
    expect(after?.enabled).toBe(false)
  })

  it('未登録(Google 認証のみ)はモードを読めず、書けない', async () => {
    const anon = await signInAs(UNREGISTERED_EMAIL)
    const { data: read, error: readErr } = await anon.from('scan_modes').select('id, name')
    expect(readErr).toBeNull()
    expect(read?.length).toBe(0)

    const { error: insErr } = await anon.from('scan_modes').insert({ name: 'scan_test_未登録', actions: [{ column: 'A' }] })
    expect(insErr).not.toBeNull()
  })

  it('証跡 scan_events は登録済みユーザが insert でき、日時と書いた値が読める', async () => {
    const user = await signInAs(REGISTERED_EMAIL)
    const { data: mode } = await user.from('scan_modes').select('id').eq('name', 'チェックイン').single()
    expect(mode?.id).toBeTypeOf('number')

    const rows = [
      { code: 'SCAN001', mode_id: mode!.id, mode_name: 'チェックイン', name: '山田太郎', actor_email: REGISTERED_EMAIL, status: 'ok', written: { 来場済: '済', 来場日時: '2026-11-16 09:02 (JST)' }, sheet_range: "'フォームの回答 1'!D12" },
      { code: 'SCAN002', mode_id: mode!.id, mode_name: 'チェックイン', name: '鈴木花子', actor_email: REGISTERED_EMAIL, status: 'duplicate', written: {}, sheet_range: null },
      { code: 'SCAN003', mode_id: mode!.id, mode_name: 'チェックイン', name: null, actor_email: REGISTERED_EMAIL, status: 'not_found', written: {}, sheet_range: null },
    ]
    const { error: insErr } = await user.from('scan_events').insert(rows)
    expect(insErr).toBeNull()

    // code 指定の履歴(監査の「このチケットがいつ読まれたか」)
    const { data: one, error: oneErr } = await user.from('scan_events').select('seq, code, mode_name, status, written, sheet_range, at').eq('code', 'SCAN001')
    expect(oneErr).toBeNull()
    expect(one?.length).toBe(1)
    expect((one![0].written as Record<string, string>)['来場済']).toBe('済')
    expect(one![0].sheet_range).toBe("'フォームの回答 1'!D12")

    // 期間・mode_name の絞り込みと status の混合
    const { data: all, error: allErr } = await user
      .from('scan_events')
      .select('seq, code, status')
      .eq('mode_name', 'チェックイン')
      .order('seq', { ascending: false })
    expect(allErr).toBeNull()
    expect(all?.length).toBe(3)
    // seq 降順 = 新しい順。挿入順の連番なので uuid と違い「新しい順」が確定する
    expect(all?.map((r) => r.code)).toEqual(['SCAN003', 'SCAN002', 'SCAN001'])

    // seq 降順のキーセットカーソル(2件取って次のカーソルで残りを取る)
    const { data: page1 } = await user.from('scan_events').select('seq, code').eq('mode_name', 'チェックイン').order('seq', { ascending: false }).limit(2)
    const cursor = page1![page1!.length - 1].seq
    const { data: page2 } = await user.from('scan_events').select('seq, code').eq('mode_name', 'チェックイン').lt('seq', cursor).order('seq', { ascending: false })
    expect(page2?.map((r) => r.code)).toEqual(['SCAN001'])
    expect(page2?.length).toBe(1)

    // 証跡は不変: authenticated に update/delete のポリシーが無いので、試行は「0件」で静かに空振りする
    // (PostgREST は RLS で弾かれた update/delete を error にしない)。だから結果の値で不変性を確認する。
    const { data: upd } = await user.from('scan_events').update({ status: 'ok' }).eq('code', 'SCAN002').select('status')
    expect(upd?.length).toBe(0)
    const { data: del } = await user.from('scan_events').delete().eq('code', 'SCAN002').select('code')
    expect(del?.length).toBe(0)
    const { data: unchanged } = await user.from('scan_events').select('status').eq('code', 'SCAN002')
    expect(unchanged?.length).toBe(1)
    expect(unchanged![0].status).toBe('duplicate')

    await purgeEvents('チェックイン')
  })

  it('記録履歴のあるモードは削除できない(FK の restrict = 証跡を残す設計)', async () => {
    const user = await signInAs(REGISTERED_EMAIL)
    const { data: mode } = await user.from('scan_modes').select('id').eq('name', 'チェックイン').single()
    const { error: insErr } = await user
      .from('scan_events')
      .insert({ code: 'SCAN004', mode_id: mode!.id, mode_name: 'チェックイン', status: 'ok', written: { 来場済: '済' } })
    expect(insErr).toBeNull()

    const { error: delErr } = await user.from('scan_modes').delete().eq('id', mode!.id)
    expect(delErr).not.toBeNull()
    // 無効化はできる(履歴を残しつつ画面から隠す運用)
    const { error: offErr } = await user.from('scan_modes').update({ enabled: false }).eq('id', mode!.id)
    expect(offErr).toBeNull()
    await user.from('scan_modes').update({ enabled: true }).eq('id', mode!.id)

    await purgeEvents('チェックイン')
    // 履歴が消えれば削除できる(restrict は残っている行に対してだけ効く)
    const { error: delNow } = await user.from('scan_modes').delete().eq('id', mode!.id)
    expect(delNow).toBeNull()
    // シードを戻す(次のテストが既定プリセットを読むため)
    const { error: reErr } = await admin.from('scan_modes').insert({
      name: 'チェックイン',
      actions: [{ column: '来場済', column_at: '来場日時', literal: '済', payload_key: '来場済', payload_at_key: '来場日時' }],
      dedupe: 'warn',
      confirm_before_record: true,
      require_found: true,
      enabled: true,
    })
    expect(reErr).toBeNull()
  })

  it('未登録ユーザは証跡を読めず、書けない(監査履歴は登録済みユーザのみ)', async () => {
    const anon = await signInAs(UNREGISTERED_EMAIL)
    const { data: read, error: readErr } = await anon.from('scan_events').select('seq, code')
    expect(readErr).toBeNull()
    expect(read?.length).toBe(0)
    const { error: insErr } = await anon.from('scan_events').insert({ code: 'SCAN005', mode_name: 'チェックイン', status: 'ok' })
    expect(insErr).not.toBeNull()
  })
})
