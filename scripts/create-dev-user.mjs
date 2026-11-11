/**
 * ローカル Supabase の UI 検証用テストユーザを作成する(dev 限定のパスワードログイン用)。
 * 使い方: node scripts/create-dev-user.mjs [email] [password] [--no-registration]
 *
 * 作成内容:
 * 1. auth.users に email 検証済み(password 設定済み)のユーザを作成
 * 2. public.users に事前登録行(email/name)を挿入(--no-registration でスキップ)
 * → 既定は dev ログイン時に link_my_user() が自動で auth_user_id を紐付けする。
 * --no-registration のユーザは未登録のまま dev ログインすると /unauthorized に誘導され、
 * QRによる許可依頼フロー(新しい利用者側)の検証ができる。
 */
import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

let status
try {
  status = JSON.parse(
    execFileSync('node_modules/.bin/supabase', ['status', '--output', 'json'], { encoding: 'utf8' }),
  )
} catch {
  console.error('ローカル Supabase が起動していません。`npm run supabase:start` を実行してください。')
  process.exit(1)
}

const email = process.argv[2] ?? 'dev@example.com'
const password = process.argv[3] ?? 'dev-password-2026'
const unregistered = process.argv.includes('--no-registration')

const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY)

// 再作成に備えて既存を掃除(admin API は RLS をバイパスする)
const { data: list } = await admin.auth.admin.listUsers()
const existing = list?.users.find((u) => u.email === email)
if (existing) await admin.auth.admin.deleteUser(existing.id)
await admin.from('users').delete().eq('email', email)

const { error: userErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
if (userErr) throw new Error(`auth.createUser: ${userErr.message}`)

if (unregistered) {
  console.log(`dev ユーザ作成(未登録): ${email} / password: ${password}`)
  console.log('users 行なし → dev ログイン後 /unauthorized に誘導され、QRの許可依頼ができます')
} else {
  const { error: rowErr } = await admin.from('users').insert({ email, name: 'dev user' })
  if (rowErr) throw new Error(`users insert: ${rowErr.message}`)
  console.log(`dev ユーザ作成(事前登録済み): ${email} / password: ${password}`)
  console.log('login ページの dev フォームからログインできます(初回ログインで users 行に自動紐付け)')
}
