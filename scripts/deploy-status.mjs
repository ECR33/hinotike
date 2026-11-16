// 本番デプロイの状態を短時間で確認するスクリプト。
//
// このリポジトリの本番デプロイは GitHub Actions(`.github/workflows/deploy.yml`)が
// `main` の push で走る(単体テスト → typecheck → 必須変数のガード → `npm run build`
// → `npx wrangler deploy`)。所以**デプロイ自体は push で完了する** — ローカルで
// `npm run deploy:cf` を実行する必要はない(ローカルの wrangler ログインは期限切れになる)。
//
//   node scripts/deploy-status.mjs        # HEAD が本番に出ているか+本番の健全性
//   node scripts/deploy-status.mjs --wait # deploy ジョブの完了まで待つ
//
// Cloudflare の secret(GOOGLE_SERVICE_ACCOUNT_JSON)や同期設定(spreadsheet_id)は
// ダッシュボード側なので、このスクリプトは確認しない(必要なら `npx wrangler login`
// → `npx wrangler secret list` / `npx wrangler deployments list`)。
import { execFileSync } from 'node:child_process'

const WORKFLOW = 'deploy.yml'
const PROD_URL = process.env.PROD_HEALTH_URL ?? 'https://hinotike.hinogakuenpta.org/api/health'
const wait = process.argv.includes('--wait')

function sh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim()
}

function ghAvailable() {
  try {
    sh(['auth', 'status'])
    return true
  } catch {
    return false
  }
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const failures = []
if (!ghAvailable()) {
  failures.push('gh CLI が認証されていない(`gh auth login` か GH_TOKEN が必要)')
} else {
  const runs = JSON.parse(sh(['run', 'list', '--workflow', WORKFLOW, '--limit', '3', '--json', 'databaseId,headSha,conclusion,status,createdAt,url']))
  const mine = runs.filter((r) => r.headSha === head)
  if (mine.length === 0) {
    failures.push(`HEAD(${head.slice(0, 7)})の deploy ジョブが見つからない → push されていないか、まだ走っていない`)
  } else {
    let run = mine[0]
    if (wait && run.status !== 'completed') {
      let tries = 0
      while (run.status !== 'completed' && tries < 30) {
        await new Promise((r) => setTimeout(r, 5000))
        tries += 1
        run = JSON.parse(sh(['run', 'view', String(run.databaseId), '--json', 'databaseId,conclusion,status,url']))
      }
    }
    console.log(`deploy job: ${run.status} / ${run.conclusion} (${run.createdAt}) ${run.url}`)
    if (run.status !== 'completed') failures.push('deploy ジョブがまだ走っている(--wait で待つか、後で再実行する)')
    else if (run.conclusion !== 'success') failures.push(`deploy ジョブが ${run.conclusion}(ログ: gh run view ${run.databaseId} --log)`)
  }
}

const res = await fetch(PROD_URL).catch((e) => null)
if (!res) failures.push(`本番の health が取れない(${PROD_URL})`)
else {
  const body = await res.text().catch(() => '')
  console.log(`本番 health: ${res.status} ${body.slice(0, 80)}`)
  if (res.status !== 200) failures.push(`本番 health が ${res.status}`)
}

console.log(`verdict: ${failures.length === 0 ? `OK(HEAD ${head.slice(0, 7)} が本番に反映済み)` : `FAIL: ${failures.join(' / ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
