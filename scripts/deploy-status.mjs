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
// Cloudflare の secret(GOOGLE_SERVICE_ACCOUNT_JSON)やデータセット定義(sync_sources の行)は
// ダッシュボード側なので、このスクリプトは確認しない(必要なら `npx wrangler login`
// → `npx wrangler secret list` / `npx wrangler deployments list`)。
// ただし本番 DB に `public.sync_sources` が**あるか**(マイグレーション 0007/0008 の適用)は
// 本番の `/api/health` の `configured.datasetTable` で見る — 未適用だとデプロイは成功しても
// アプリは壊れている(/sync・/scan・/items・/result が 500。docs/datasets.md の 8 節)。
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
  let mine = []
  // push 直後はジョブが一覧に出ないので、見つかるまで少し待つ(--wait の有無に関係なく)
  for (let tries = 0; tries < 12; tries++) {
    const runs = JSON.parse(sh(['run', 'list', '--workflow', WORKFLOW, '--limit', '3', '--json', 'databaseId,headSha,conclusion,status,createdAt,url']))
    mine = runs.filter((r) => r.headSha === head)
    if (mine.length > 0) break
    await new Promise((r) => setTimeout(r, 5000))
  }
  if (mine.length === 0) {
    failures.push(`HEAD(${head.slice(0, 7)})の deploy ジョブが見つからない(60秒待っても出ない) → push されていないか、workflow が走っていない`)
  } else {
    let run = mine[0]
    if (wait && run.status !== 'completed') {
      let tries = 0
      while (run.status !== 'completed' && tries < 30) {
        await new Promise((r) => setTimeout(r, 5000))
        tries += 1
        run = JSON.parse(sh(['run', 'view', String(run.databaseId), '--json', "databaseId,conclusion,status,url,createdAt"]))
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
  console.log(`本番 health: ${res.status} ${body.slice(0, 120)}`)
  if (res.status !== 200) failures.push(`本番 health が ${res.status}`)
  else {
    // `configured.datasetTable` = 本番 DB に `public.sync_sources` があるか(マイグレーション 0007/0008)。
    // 未適用だとコードのデプロイは成功しても `/sync`・`/scan`・`/items`・`/result` が 500 で壊れる
    // (docs/datasets.md の 8 節)。この判定がないと「deploy succeeded / 画面は不動」を見逃す。
    let j = null
    try {
      j = JSON.parse(body)
    } catch {
      failures.push('本番 health の JSON が読めない(deploy-status の datasetTable 判定が使えない)')
    }
    if (j && j.configured && j.configured.datasetTable === false) {
      failures.push(
        '本番 DB にマイグレーション 0007/0008 が未適用(sync_sources が無い)→ ' +
          '`npx supabase migration list --remote=<ref>` → `npx supabase db push --remote=<ref> --yes`',
      )
    }
  }
}

console.log(`verdict: ${failures.length === 0 ? `OK(HEAD ${head.slice(0, 7)} が本番に反映済み)` : `FAIL: ${failures.join(' / ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
