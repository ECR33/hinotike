/**
 * ローカル Supabase に対して統合フローテスト(vitest)を実行する。
 * 事前に `npm run supabase:start` が必要。
 */
import { execFileSync } from 'node:child_process'

let status
try {
  status = JSON.parse(
    execFileSync('node_modules/.bin/supabase', ['status', '--output', 'json'], { encoding: 'utf8' }),
  )
} catch {
  console.error('ローカル Supabase が起動していません。`npm run supabase:start` を実行してください。')
  process.exit(1)
}

if (!status.API_URL || !status.PUBLISHABLE_KEY || !status.SERVICE_ROLE_KEY) {
  console.error('ローカル Supabase のキーを取得できませんでした。`npm run supabase:start` を実行してください。')
  process.exit(1)
}

execFileSync('npm', ['run', 'test'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    SUPABASE_URL: status.API_URL,
    SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: status.SERVICE_ROLE_KEY,
  },
})
