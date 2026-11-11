/**
 * QRによる利用者許可フローのエンドポイント検証(dev サーバ + ローカル Supabase + devログイン)。
 * ブラウザ(UI・カメラ)は使わず、HTTP で API 一式を確認する:
 *   依頼作成(/api/registration-request) → preview(/api/approval-preview) →
 *   approve(/api/approval-approve) → 依頼者の /api/me が authorized:true → 再利用は consumed
 * 実行: `npm run dev` を別ターミナルで起動した状態で `node scripts/verify-registration-flow.mjs`
 * (devログインは本番では404のため dev モード + ローカル Supabase でのみ動く)
 */
import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000'
const APPROVER = 'qr-verify-approver@example.com'
const REQUESTER = 'qr-verify-requester@example.com'
const PASSWORD = 'dev-password-2026'

let status
try {
  status = JSON.parse(
    execFileSync('node_modules/.bin/supabase', ['status', '--output', 'json'], { encoding: 'utf8' }),
  )
} catch {
  console.error('ローカル Supabase が起動していません。`npm run supabase:start` を実行してください。')
  process.exit(1)
}

const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY)

async function cleanup() {
  const { data: list } = await admin.auth.admin.listUsers()
  for (const u of list?.users ?? []) {
    if (u.email === APPROVER || u.email === REQUESTER) await admin.auth.admin.deleteUser(u.id)
  }
  await admin.from('users').delete().eq('email', APPROVER)
  await admin.from('users').delete().eq('email', REQUESTER)
}

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`dev-login ${email}: HTTP ${res.status}`)
  const cookies = res.headers.getSetCookie?.() ?? []
  return cookies.map((c) => c.split(';')[0]).join('; ')
}

async function post(cookie, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}

function expect(cond, label) {
  if (!cond) throw new Error(`FAIL: ${label}`)
  console.log(`ok: ${label}`)
}

async function main() {
  // dev サーバが生きているか(ヘルスチェック)
  const health = await fetch(`${BASE}/api/health`).catch(() => null)
  if (!health?.ok) throw new Error(`dev サーバに接続できません: ${BASE}`)

  await cleanup()
  // 許可者: authユーザ + 事前登録行(dev-login の link_my_user で自動紐付け)
  await admin.auth.admin.createUser({ email: APPROVER, password: PASSWORD, email_confirm: true })
  await admin.from('users').insert({ email: APPROVER, name: 'verifier approver' })
  // 依頼者: authユーザのみ(users 行なし = 未登録)
  await admin.auth.admin.createUser({ email: REQUESTER, password: PASSWORD, email_confirm: true })

  const requesterCookie = await login(REQUESTER)
  // dev-login の link_my_user は事前登録行がないので紐付けされないはず
  const meBefore = await (await fetch(`${BASE}/api/me`, { headers: { cookie: requesterCookie } })).json()
  expect(meBefore.authenticated === true && meBefore.authorized === false, '依頼者は認証済み・未登録')

  const req = await post(requesterCookie, '/api/registration-request')
  expect(req.status === 200 && typeof req.data?.token === 'string', '依頼作成 200 + token')
  expect(req.data.token.startsWith('hinotike-registration:'), 'token は登録QR接頭辞付き')

  // 未登録ユーザの preview/approve は 403(guard が登録必須)
  const forbiddenPreview = await post(requesterCookie, '/api/approval-preview', { code: req.data.token })
  expect(forbiddenPreview.status === 403, '未登録ユーザの preview は 403')

  const approverCookie = await login(APPROVER)
  const preview = await post(approverCookie, '/api/approval-preview', { code: req.data.token })
  expect(preview.status === 200 && preview.data?.status === 'ok', 'preview status=ok')
  expect(preview.data?.email === REQUESTER, 'preview が依頼者の email を返す')

  const approve = await post(approverCookie, '/api/approval-approve', { code: req.data.token })
  expect(approve.status === 200 && approve.data?.status === 'ok', 'approve status=ok')

  const meAfter = await (await fetch(`${BASE}/api/me`, { headers: { cookie: requesterCookie } })).json()
  expect(meAfter.authorized === true, 'approve 後、依頼者は authorized:true')

  const reuse = await post(approverCookie, '/api/approval-approve', { code: req.data.token })
  expect(reuse.status === 200 && reuse.data?.status === 'consumed', '同じQRの再利用は consumed')

  const badCode = await post(approverCookie, '/api/approval-preview', { code: 'item-code-not-registration' })
  expect(badCode.status === 400, 'items照会用QRコードの値は 400(code_invalid)')

  console.log('PASS: QR利用者許可フロー検証')
}

main()
  .catch((e) => {
    console.error(e.message ?? e)
    process.exitCode = 1
  })
  .finally(async () => {
    await cleanup()
  })
