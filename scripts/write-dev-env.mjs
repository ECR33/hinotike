/**
 * ローカル Supabase の開発環境ファイル(.env.development)を `supabase status` から書き直す。
 * `supabase start` / `supabase db reset` は開発キーを再生成するので、その後にこれを走れば dev と
 * スクリプト(test-local.mjs / verify-*.mjs)が同じキーを読む。使い方: node scripts/write-dev-env.mjs
 * (docker group が効いた shell で `npm run dev-env` でも可。グループが反映されていない shell では
 *  `sg docker -c 'npm run dev-env'`)。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { mergeDevEnv } from './dev-env-merge.mjs'

let status
try {
  status = JSON.parse(
    execFileSync('node_modules/.bin/supabase', ['status', '--output', 'json'], { encoding: 'utf8' }),
  )
} catch {
  console.error('ローカル Supabase が起動していません。`npm run supabase:start` を実行してください。')
  process.exit(1)
}

const url = status.API_URL
const publishable = status.PUBLISHABLE_KEY
const secret = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY
if (!url || !publishable || !secret) {
  console.error('supabase status からキーを取得できませんでした:', JSON.stringify(status).slice(0, 200))
  process.exit(1)
}

const file = path.resolve(process.cwd(), '.env.development')

// 既存の .env.development を**置き換えない**(Supabase のキーだけ書き換える)。
// 丸ごと書くとこのファイルにある別の設定(GOOGLE_SERVICE_ACCOUNT_JSON_PATH / GOOGLE_SPREADSHEET_ID /
// DEV_ALLOWED_HOSTS / NUXT_PUBLIC_APP_URL)が消え、dev のシート操作が「鍵なし」で落ちる
// (server/utils/googleSheets.ts は dev では `GOOGLE_SERVICE_ACCOUNT_JSON_PATH` から鍵を読む)。
const updates = {
  NUXT_PUBLIC_SUPABASE_URL: url,
  NUXT_PUBLIC_SUPABASE_KEY: publishable,
  SUPABASE_URL: url,
  SUPABASE_PUBLISHABLE_KEY: publishable,
  SUPABASE_SECRET_KEY: secret,
}

const existed = fs.existsSync(file)
const lines = mergeDevEnv(existed ? fs.readFileSync(file, 'utf8') : null, updates)
fs.writeFileSync(file, lines.join('\n'))
console.log(
  `${existed ? '.env.development の Supabase キーを更新' : '.env.development を作成'}しました: ${file} (${url})`,
)
