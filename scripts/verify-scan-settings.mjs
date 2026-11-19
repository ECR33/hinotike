// `/scan-settings`(記録モードの設定画面)の実挙動検証。dev サーバ + ローカル Supabase が必要。
//
// 検証するのは「設定の導線と増減・変更・削除」:
//   1) 使い捨てのモードを作成(「既存の列だけ使う」なので Google のシートに列を書かない)
//   2) /scan のモードチップに現れるか(設定 → スキャンの反映)
//   3) 設定画面で名前と重複の扱いを変えて保存できるか(DB に反映)
//   4) 削除できるか(= /api/scan-config の「リストが正」で行が消える)
//   5) /scan・/records・bottom nav(dropdown)から設定画面へ到達できるか
//
// シートの列追加ボタンは押さない(設定されたシートに列を書く副作用がある)。列の有無の注記は
// 「シートに列がありません」の文言が出ることを確認するだけ(scripts/verify-scan-record.mjs が読み取り側)。
//
// 使い方: node scripts/verify-scan-settings.mjs [baseUrl]
import { chromium } from 'playwright-core'

const base = process.argv[2] ?? 'http://127.0.0.1:3000'
const THROWAWAY_NAME = 'scan設定検証用のモード'
const RENAMED_NAME = 'scan設定検証用のモード(改名)'

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 140)}`)
})

const failures = []

async function login() {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'dev ログイン' }).click()
  await page.waitForFunction(() => location.pathname === '/scan', { timeout: 15000 })
}

async function configModes() {
  return page.evaluate(async () => {
    const r = await fetch('/api/scan-config')
    if (!r.ok) return null
    const j = await r.json()
    return j.modes.map((m) => ({ name: m.name, dedupe: m.dedupe, enabled: m.enabled, columns: m.actions.map((a) => a.column) }))
  })
}

// モードチップ行だけを読む(camera 直下の .chip-row。管理欄(details)の中にも .mode-row があるので絞る)
async function chipNames() {
  return page.evaluate(() => [...document.querySelectorAll('.chip-row .btn')].map((b) => b.textContent?.trim() ?? ''))
}

/** カードは click 時に hasText を再解決するので、名前を変えても残るカラム名で特定する。 */
function cardByText(text) {
  return page.locator('.mode-card', { hasText: text })
}

async function saveDrafts() {
  await page.getByRole('button', { name: '変更を保存' }).click()
  await page.waitForFunction(() => !document.body.textContent?.includes('保存中…'), { timeout: 25000 })
  await page.waitForFunction(() => document.body.textContent?.includes('保存しました'), { timeout: 20000 }).catch(() =>
    failures.push('保存の注記が出ない'),
  )
}

try {
  await login()
  const before = await configModes()
  if (!before) {
    failures.push('/api/scan-config が読めない(dev サーバ / 認証 / RLS を確認)')
  }

  // 前の実行が途中で失敗して残った検証用モードを消しておく(同名で作成に失敗しないようにするため。
  // 「リストが正」を POST するので、残骸だけを落とせば既定プリセットはそのまま残る)
  await page
    .evaluate(async (names) => {
      const r = await fetch('/api/scan-config')
      if (!r.ok) return
      const j = await r.json()
      const keep = (j.modes ?? []).filter((m) => !names.some((n) => m.name === n || m.name === `${n}(改名)`))
      if (keep.length === (j.modes ?? []).length) return
      await fetch('/api/scan-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modes: keep }),
      })
    }, [THROWAWAY_NAME, RENAMED_NAME])
    .catch(() => {})

  await page.goto(`${base}/scan-settings`, { waitUntil: 'networkidle' })
  console.log(`設定画面のモード: ${JSON.stringify((await configModes())?.map((m) => m.name))}`)
  // 列がシートのヘッダーに無いときの注記(既定プリセットの 配布済/来場済 は dev シートに無いので出る)
  const columnNote = await page.evaluate(() => document.body.textContent?.includes('シートのヘッダーにありません'))
  console.log(`「シートのヘッダーにありません」の注記: ${columnNote ? '出る' : '出ない(列が実在 or ヘッダー未取得)'}`)
  // シートへ書かない(既存の列だけ使う)で作る
  await page.getByRole('button', { name: 'シートの列を追加する(取り込みカラムにも追加)' }).click()
  await page.getByPlaceholder('例: ボランティア確認').fill(THROWAWAY_NAME)
  await page.getByPlaceholder('例: 確認済').fill('検証済')
  await page.getByRole('button', { name: '作成して保存' }).click()
  await page.waitForFunction(() => document.body.textContent?.includes('作りました'), { timeout: 25000 }).catch(() =>
    failures.push('作成の注記が出ない'),
  )
  const created = (await configModes())?.find((m) => m.name === THROWAWAY_NAME)
  if (!created) failures.push(`作成した ${THROWAWAY_NAME} が DB に現れない`)

  // 2) /scan のチップに現れるか + 列が無いモードを選ぶとスキャン前に注記が出るか
  await page.goto(`${base}/scan`, { waitUntil: 'networkidle' })
  if (!(await chipNames()).includes(THROWAWAY_NAME)) failures.push('/scan のモードチップに作成したモードが現れない')
  // 「記録の設定」への導線は管理欄(折りたたみ)の中。開いてから数える(閉じた欄のリンクは押せない)
  await page.locator('.admin-card > summary').click()
  if ((await page.getByRole('link', { name: '記録の設定' }).count()) === 0) failures.push('/scan の管理欄に設定画面へのリンクがない')
  await page.getByRole('button', { name: THROWAWAY_NAME }).click()
  await page.waitForTimeout(800)
  const scanNote = await page.evaluate(() => document.body.textContent?.includes('このモードの列がシートにありません'))
  console.log(`/scan の「列がシートにありません」注記: ${scanNote ? '出る' : '出ない(列が実在 or ヘッダー未取得)'}`)

  // 3) 設定画面で改名 + 重複の扱いの変更
  await page.goto(`${base}/scan-settings`, { waitUntil: 'networkidle' })
  const target = cardByText('検証済')
  if ((await target.count()) !== 1) failures.push('作成したモードのカードが1枚でない')
  await target.locator('input').first().fill(RENAMED_NAME)
  await target.locator('button', { hasText: '重複: 上書き' }).click()
  await saveDrafts()
  const renamed = (await configModes())?.find((m) => m.name === RENAMED_NAME)
  if (!renamed) failures.push('改名が DB に反映されない')
  else if (renamed.dedupe !== 'allow') failures.push(`重複の扱いが ${renamed.dedupe}(期待 allow)`)

  // 4) 削除(リストから消す → 保存で DB の行も消える)
  await cardByText('検証済').locator('button', { hasText: 'このモードを削除' }).click()
  await saveDrafts()
  const afterDelete = await configModes()
  if (afterDelete?.some((m) => m.name === RENAMED_NAME)) failures.push('削除したモードがまだ DB に残っている')
  if (!afterDelete?.some((m) => m.name === 'チケット配布') || !afterDelete?.some((m) => m.name === 'チェックイン')) {
    failures.push('既定プリセットのモードが消えた(削除は使い捨てモードだけのはず)')
  }

  // 5) 導線(/records と bottom nav の dropdown)
  await page.goto(`${base}/scan`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '管理' }).click()
  const navItems = await page.evaluate(() => [...document.querySelectorAll('nav a')].map((a) => a.textContent?.trim() ?? ''))
  if (!navItems.includes('記録の設定')) failures.push('bottom nav の dropdown に「記録の設定」がない')
  await page.goto(`${base}/records`, { waitUntil: 'networkidle' })
  if ((await page.getByRole('link', { name: '記録の設定' }).count()) === 0) failures.push('/records に設定画面へのリンクがない')

  console.log(`作成前: ${JSON.stringify(before?.map((m) => m.name))} / 削除後: ${JSON.stringify(afterDelete?.map((m) => m.name))}`)
  console.log(`nav dropdown: ${JSON.stringify(navItems)}`)
} catch (e) {
  failures.push(`例外: ${e instanceof Error ? e.message : String(e)}`)
}

if (errors.length) failures.push(`画面エラー: ${errors.join(' | ')}`)
if (failures.length) {
  console.log(`FAIL: ${failures.join(' / ')}`)
  console.log(`画面=${(await page.textContent('body').catch(() => '')).slice(0, 200)}`)
}
console.log(`verdict: ${failures.length === 0 ? 'OK(設定の増減・変更・削除と導線が動作)' : 'FAIL'}`)
await browser.close()
process.exit(failures.length === 0 ? 0 : 1)
