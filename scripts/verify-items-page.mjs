/**
 * /items(レコード一覧)の headless Chrome 検証。
 *   - SSR/初回: 1バッチだけ描画され、総件数が status に出る
 *   - スロール追記: 最下部に到達すると次のバッチが自動で追加され、最終的に全件になる
 *   - インクリメンタル検索: 氏名/code の部分一致で列が絞られ、入力の連打は1照会にまとまる
 *   - 年・組の chip 絞り込み: 同一 facet は OR(件数の和)、年×組は AND(和より少ない)
 *   - 条件をリセット: 入力・年・組が一度に消え、無条件の総件数に戻る(条件なし時はボタン無効)
 *   - 入力の消去ボタン(clearable 相当): 値があるときだけ出て、押すと空になる
 *   - /scan の手入力欄が撤去されている( placeholder が存在しない)
 *   - bottom navigation とコンテンツの重なり(一覧は長いリストなので確認する)
 * 使い方: node scripts/verify-items-page.mjs [baseUrl] [email:password]
 *   既定 baseUrl=http://127.0.0.1:3000 / 既定ユーザ dev@example.com:dev-password-2026
 *   (dev ログインはローカル Supabase + dev モードでのみ動く: npm run supabase:dev-user)
 */
import { chromium } from 'playwright-core'

const base = process.argv[2] ?? 'http://127.0.0.1:3000'
const approver = (process.argv[3] ?? 'dev@example.com:dev-password-2026').split(':')

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
const ctx = await browser.newContext({ viewport: { width: 390, height: 720 } })
const page = await ctx.newPage()

const warns = []
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') warns.push(`${m.type()}: ${m.text().slice(0, 160)}`)
})
const listRequests = []
page.on('request', (r) => {
  if (r.url().includes('/api/items-list')) listRequests.push(r.url().replace(base, ''))
})

const out = []
let ok = true

async function login() {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
  await page.fill('input[placeholder="email"]', approver[0])
  await page.fill('input[placeholder="password"]', approver[1])
  await page.getByRole('button', { name: 'dev ログイン' }).click()
  await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('QR'), { timeout: 10000 })
}

function rowCodes() {
  return page.locator('.item-row .item-code').evaluateAll((els) => els.map((el) => el.textContent.trim()))
}
function rowNames() {
  return page.locator('.item-row .item-name').evaluateAll((els) => els.map((el) => el.textContent.trim()))
}
function rowMeta() {
  // 行の年・組表示(ItemRow の .item-meta の子要素。欠落は要素が出ない)
  return page.locator('.item-meta').evaluateAll((els) => els.map((el) => [...el.children].map((c) => c.textContent.trim())))
}
function chipTexts() {
  return page.locator('.chip').evaluateAll((els) => els.map((el) => el.textContent.trim()))
}
async function activeChipTexts() {
  return page.locator('.chip.active').evaluateAll((els) => els.map((el) => el.textContent.trim()))
}
/** chip 名は「1年41」のような形(値+接尾語+件数)。接尾語付きの label の先頭で打つ。 */
async function toggleChip(label) {
  await page.locator('.chip', { hasText: new RegExp(`^${label}`) }).first().click()
  await page.waitForTimeout(350)
}
/** status の総件数が expected に確定するまで待つ(「検索中…」は parseInt で弾かれる)。 */
async function waitTotal(expected) {
  await page.waitForFunction(`parseInt(document.querySelector('.status').textContent) === ${expected}`, { timeout: 6000 })
}
function statusTotal() {
  return statusText().then((t) => Number(t.match(/(\d+)\s*件中/)?.[1] ?? -1))
}
function statusText() {
  return page.locator('.status').textContent().then((t) => t.trim())
}
function rowCount() {
  return page.locator('.item-row').count()
}

await login()

// /scan に手入力欄が残っていないこと(撤去の確認)
const manual = await page.getByPlaceholder('コードを直接入力').count()
out.push(`scan: 手入力欄の数=${manual}(0 が期待値)`)
if (manual !== 0) ok = false

// nav に「一覧」が出て、/items に着地する
await page.getByRole('link', { name: '一覧' }).click()
await page.waitForFunction(() => location.pathname === '/items', { timeout: 5000 })
// nav の active は vue の再活性で少し後に確定するので、確定してから読む
await page.waitForFunction(
  () => [...document.querySelectorAll('.bottom-nav .nav-item.active')].some((el) => el.textContent.trim() === '一覧'),
  { timeout: 5000 },
)
const navActive = await page
  .locator('.bottom-nav .nav-item.active')
  .evaluateAll((els) => els.map((el) => el.textContent.trim()))
out.push(`items: nav active=${navActive.join(',')}(一覧 が期待値)`)
if (!navActive.includes('一覧')) ok = false

// 初回バッチ(全件描画ではない)
await page.waitForFunction(() => document.querySelectorAll('.item-row').length > 0, { timeout: 10000 })
const firstRows = await rowCount()
const status = await statusText()
const total = Number(status.match(/(\d+)\s*件中/)?.[1] ?? -1)
out.push(`items: 初回描画=${firstRows}行 / status="${status}" / total=${total}`)
if (firstRows < 1 || total <= firstRows) ok = false

// スロール追記(最下部に届くと次のバッチが自動で増える)
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
await page.waitForFunction(`document.querySelectorAll('.item-row').length > ${firstRows}`, { timeout: 8000 })
const grewTo = await rowCount()
out.push(`items: 1回目の追記後=${grewTo}行(初回 ${firstRows}行 より増える)`)
if (grewTo <= firstRows) ok = false

// 最終までスクロールして全件になる(done 表示が出る)
let doneText = false
for (let i = 0; i < 40; i++) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await page.waitForTimeout(250)
  if ((await page.textContent('.sentinel')).includes('最後まで表示しました')) {
    doneText = true
    break
  }
}
const finalRows = await rowCount()
out.push(`items: 最終描画=${finalRows}行 / total=${total} / done表示=${doneText}`)
if (!doneText || finalRows !== total) ok = false

// nav とコンテンツの重なり(最下部でバーが行を隠さない)。追記が完了した後に最下部へ戻して測る。
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
await page.waitForTimeout(400)
const gap = await page.evaluate(() => {
  const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect()
  if (!nav) return null
  let minGap = Infinity
  for (const el of document.querySelectorAll('.item-row, .card, .btn, .field, h1, h2, p')) {
    const r = el.getBoundingClientRect()
    if (r.height === 0) continue
    minGap = Math.min(minGap, nav.top - r.bottom)
  }
  return Math.round(minGap)
})
out.push(`items: nav と最下部コンテンツの最小隙間=${gap}px(0以上が期待値)`)
if (gap === null || gap < 0) ok = false

// 年・組の欄は折りたたみ(v-show)。閉じたままでも chip は DOM にあるが表示されない(縦の場所を取らない)
const facetToggle = page.locator('.facet-toggle')
const chips = await chipTexts()
const expandedInitial = await facetToggle.getAttribute('aria-expanded')
const chipsVisibleInitial = await page.locator('.chip').first().isVisible()
out.push(
  `折りたたみ: 初期 aria-expanded=${expandedInitial}(false が期待値) / DOM の chip=${chips.length}(SSR で出る=${chips.length >= 10}) / 閉じた時の chip 表示=${chipsVisibleInitial}(false が期待値)`,
)
if (expandedInitial !== 'false' || chips.length < 10 || chipsVisibleInitial) ok = false

await facetToggle.click()
await page.waitForTimeout(200)
if (!(await facetToggle.getAttribute('aria-expanded'))) ok = false
if (!(await page.locator('.chip').first().isVisible())) ok = false

// 年・組の絞り込み(chip の多选択: 同一 facet 内は OR、年×組の間は AND)
function chipCount(label) {
  return page
    .locator('.chip', { hasText: new RegExp(`^${label}`) })
    .first()
    .textContent()
    .then((t) => Number(t.match(/(\d+)$/)?.[1] ?? -1))
}

const year1Count = await chipCount('1年')
const year2Count = await chipCount('2年')

await toggleChip('1年')
await waitTotal(year1Count)
let meta = await rowMeta()
out.push(`年=1年 → total=${await statusTotal()}(chip の件数 ${year1Count} と一致) / 全行の年が1年=${meta.every((m) => m[0] === '1年')}`)
if (!meta.every((m) => m[0] === '1年')) ok = false

// 年を2つ選ぶと OR: 件数は2つの選択肢の件数の「和」になる(AND なら和より少なくなる)
await toggleChip('2年')
await waitTotal(year1Count + year2Count)
meta = await rowMeta()
out.push(
  `年=1年+2年 → total=${await statusTotal()}(=${year1Count}+${year2Count} の和なので OR)=${meta.every(
    (m) => m[0] === '1年' || m[0] === '2年',
  )} / active=${(await activeChipTexts()).join(',')}`,
)
if (!meta.every((m) => m[0] === '1年' || m[0] === '2年')) ok = false
if ((await activeChipTexts()).length !== 2) ok = false

// 組を加えると AND で絞られる(年の和より少ない)
await toggleChip('3組')
await page.waitForTimeout(500)
const andTotal = await statusTotal()
meta = await rowMeta()
out.push(
  `年=1年+2年 AND 組=3組 → total=${andTotal}(年の和 ${year1Count + year2Count} より少ないので AND)=${andTotal < year1Count + year2Count} / 全行の組が3組=${meta.every((m) => m[1] === '3組')}`,
)
if (andTotal >= year1Count + year2Count || !meta.every((m) => m[1] === '3組')) ok = false

// 組側の OR: 年を解除して組だけ2つ選ぶと、件数は組の選択肢の件数の「和」になる
// (年を絞ったままの組 OR はデータ依存で増減0になりうるので、和で判定する)
const group3Count = await chipCount('3組')
const group4Count = await chipCount('4組')
await toggleChip('1年')
await toggleChip('2年')
await waitTotal(group3Count)
meta = await rowMeta()
out.push(`組=3組だけ(年なし) → total=${await statusTotal()}(chip の件数 ${group3Count} と一致) / 全行の組が3組=${meta.every((m) => m[1] === '3組')}`)
if (!meta.every((m) => m[1] === '3組')) ok = false

await toggleChip('4組')
await waitTotal(group3Count + group4Count)
meta = await rowMeta()
out.push(`組=3組+4組 → total=${await statusTotal()}(=${group3Count}+${group4Count} の和なので OR)=${meta.every((m) => m[1] === '3組' || m[1] === '4組')}`)
if (!meta.every((m) => m[1] === '3組' || m[1] === '4組')) ok = false

// 絞り込み中でも選択肢は消えない(「選べなくなった理由」を隠さない)
const chipsFiltered = await chipTexts()
out.push(`絞り込み後の chip 数=${chipsFiltered.length}(初期 ${chips.length} と変化なし)=${chipsFiltered.length === chips.length}`)
if (chipsFiltered.length !== chips.length) ok = false

// chip の再押で個別の選択が解除される
await toggleChip('4組')
await waitTotal(group3Count)
out.push(`4組を再押で取消 → total=${await statusTotal()}(3組だけの ${group3Count} と一致) / active=${(await activeChipTexts()).join(',')}`)
if (await statusTotal() !== group3Count) ok = false

// 条件をリセット(code・氏名・年・組を一度に消す)
await page.getByPlaceholder('コードの一部を入力').fill('4007')
await page.waitForTimeout(500)
const resetButton = page.getByRole('button', { name: '条件をリセット' })
out.push(`条件あり時のリセットボタン disabled=${await resetButton.isDisabled()}(false が期待値)`)
if (await resetButton.isDisabled()) ok = false
await resetButton.click()
await page.waitForTimeout(600)
const resetCode = await page.inputValue('input[placeholder="コードの一部を入力"]')
const resetName = await page.inputValue('input[placeholder="氏名の一部を入力"]')
out.push(
  `リセット後 → total=${await statusTotal()}(初期 ${total}) / code入力="${resetCode}" 氏名入力="${resetName}" / 選択中 chip=${(await activeChipTexts()).length}(0)`,
)
if ((await statusTotal()) !== total || resetCode !== '' || resetName !== '' || (await activeChipTexts()).length !== 0) ok = false
out.push(`条件なし時のリセットボタン disabled=${await resetButton.isDisabled()}(true が期待値)`)
if (!(await resetButton.isDisabled())) ok = false

// 年と組の**対応**指定(年×組マトリクス)。選んだマス同士は OR → 1年3組 + 2年1組 が表現できる
const cellLocator = (label) => page.locator(`.cell[aria-label^="${label} "]`).first()
async function cellCount(label) {
  const aria = await cellLocator(label).getAttribute('aria-label')
  return Number(aria?.match(/(\d+)件/)?.[1] ?? -1)
}
async function toggleCell(label) {
  await cellLocator(label).click()
  await page.waitForTimeout(300)
}
async function activeCells() {
  return page.evaluate(() =>
    [...document.querySelectorAll('.cell')].filter((b) => b.getAttribute('aria-pressed') === 'true').length,
  )
}

await page.getByRole('button', { name: '年と組の組み合わせ' }).click()
await page.waitForTimeout(400)
const chipsInPairMode = await page.locator('.chip').first().isVisible()
const cellsVisible = await cellLocator('1年3組').isVisible()
await waitTotal(total)
out.push(
  `モード切替(組み合わせ) → chip 表示=${chipsInPairMode}(false が期待値) / セル表示=${cellsVisible}(true が期待値) / total=${await statusTotal()}(単独選択の消去で初期 ${total})`,
)
if (chipsInPairMode || !cellsVisible || (await statusTotal()) !== total) ok = false

const cell13 = await cellCount('1年3組')
const cell21 = await cellCount('2年1組')
await toggleCell('1年3組')
await waitTotal(cell13)
meta = await rowMeta()
out.push(`セル=1年3組 → total=${await statusTotal()}(セルの件数 ${cell13} と一致) / 全行が1年3組=${meta.every((m) => m[0] === '1年' && m[1] === '3組')}`)
if (!meta.every((m) => m[0] === '1年' && m[1] === '3組')) ok = false

await toggleCell('2年1組')
await waitTotal(cell13 + cell21)
meta = await rowMeta()
const pairOk = meta.every((m) => (m[0] === '1年' && m[1] === '3組') || (m[0] === '2年' && m[1] === '1組'))
out.push(`セル=1年3組+2年1組 → total=${await statusTotal()}(=${cell13}+${cell21} の和) / 全行が対応(${pairOk ? '対応のみ' : '交差を含む'})=${pairOk} / 選択中セル=${await activeCells()}(2)`)
if (!pairOk || (await activeCells()) !== 2) ok = false

// 交差(1年1組 や 2年3組)が混ざらないこと=対応指定であることを行的に確認する
const crossed = meta.filter((m) => m[0] === '1年' && m[1] !== '3組').length + meta.filter((m) => m[0] === '2年' && m[1] !== '1組').length
out.push(`交差行の件数=${crossed}(0 が期待値)`)
if (crossed !== 0) ok = false

await toggleCell('1年3組')
await waitTotal(cell21)
out.push(`セルの再押で取消 → total=${await statusTotal()}(2年1組だけの ${cell21} と一致) / 選択中セル=${await activeCells()}(1)`)
if ((await statusTotal()) !== cell21 || (await activeCells()) !== 1) ok = false

// 年または組が空のレコードはマトリクスで選べない旨を注記する(黙って減らさない)
const hintPair = await page.locator('.hint').allTextContents()
out.push(`組み合わせモードの注記=${hintPair.some((t) => t.includes('年または組が空のレコードは'))} / 0件のセルは押せない=${await cellLocator('1年4組').isDisabled()}(1年4組は件数0の可能性あり)`)
if (!hintPair.some((t) => t.includes('年または組が空のレコードは'))) ok = false

// ペア選択もリセットで一度に消える(選択モードは維持)
await resetButton.click()
await waitTotal(total)
out.push(`ペア選択後のリセット → total=${await statusTotal()}(初期 ${total}) / 選択中セル=${await activeCells()}(0) / 組み合わせモードのボタン aria-pressed=${await page.getByRole('button', { name: '年と組の組み合わせ' }).getAttribute('aria-pressed')}(true が期待値)`)
if ((await statusTotal()) !== total || (await activeCells()) !== 0 || (await page.getByRole('button', { name: '年と組の組み合わせ' }).getAttribute('aria-pressed')) !== 'true') ok = false

// 欄を閉じるとマトリクスが縦の場所を取らない(v-show で隠れるだけ)
await facetToggle.click()
await page.waitForTimeout(300)
out.push(`欄を閉じる → aria-expanded=${await facetToggle.getAttribute('aria-expanded')}(false が期待値) / セル表示=${await cellLocator('1年3組').isVisible()}(false が期待値)`)
if ((await facetToggle.getAttribute('aria-expanded')) !== 'false' || (await cellLocator('1年3組').isVisible())) ok = false
await facetToggle.click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: '年・組を単独で' }).click()
await page.waitForTimeout(400)

// 入力の消去(clearable 相当): 値があるとき右端に消去ボタンが出て、押すと空になる
await page.getByPlaceholder('コードの一部を入力').pressSequentially('40', { delay: 60 })
await page.waitForTimeout(400)
const clearBefore = await page.locator('.clearable .clear').count()
await page.locator('.clearable .clear').first().click()
await page.waitForTimeout(500)
const clearedValue = await page.inputValue('input[placeholder="コードの一部を入力"]')
const clearAfter = await page.locator('.clearable .clear').count()
out.push(`消去ボタン: 値あり時の数=${clearBefore}(1) → クリック後 value="${clearedValue}" / 値なし時の数=${clearAfter}(0) / total=${await statusTotal()}`)
if (clearBefore !== 1 || clearedValue !== '' || clearAfter !== 0) ok = false

// インクリメンタル検索: 氏名を1文字ずつ増やしながら絞られる
listRequests.length = 0
await page.getByPlaceholder('氏名の一部を入力').pressSequentially('田中', { delay: 60 })
await page.waitForFunction(
  () => {
    const names = [...document.querySelectorAll('.item-row .item-name')].map((el) => el.textContent.trim())
    return names.length > 0 && names.every((n) => n.includes('田中'))
  },
  { timeout: 6000 },
)
const nameRows1 = await rowNames()
out.push(`氏名=田中 → ${nameRows1.length}行 全て氏名に"田中"を含む=${nameRows1.every((n) => n.includes('田中'))}`)
if (!nameRows1.every((n) => n.includes('田中'))) ok = false

// 入力を追加するとさらに絞られる(部分一致が累積される)
await page.getByPlaceholder('氏名の一部を入力').pressSequentially('桔', { delay: 60 })
await page.waitForFunction(
  () => {
    const names = [...document.querySelectorAll('.item-row .item-name')].map((el) => el.textContent.trim())
    return names.length > 0 && names.every((n) => n.includes('田中桔'))
  },
  { timeout: 6000 },
)
const nameRows2 = await rowNames()
out.push(`氏名=田中桔 → ${nameRows2.length}行(前の ${nameRows1.length}行 以下)=${nameRows2.length <= nameRows1.length}`)
if (nameRows2.length > nameRows1.length || !nameRows2.every((n) => n.includes('田中桔'))) ok = false
out.push(`氏名入力の照会数=${listRequests.length}(連打はデバウンスで1〜2にまとまる)`)
if (listRequests.length > 3) ok = false

// code 検索(部分一致)
await page.getByPlaceholder('氏名の一部を入力').fill('')
await page.getByPlaceholder('コードの一部を入力').pressSequentially('100', { delay: 60 })
await page.waitForFunction(
  () => {
    const codes = [...document.querySelectorAll('.item-row .item-code')].map((el) => el.textContent.trim())
    return codes.length > 0 && codes.every((c) => c.includes('100'))
  },
  { timeout: 6000 },
)
const codeRows = await rowCodes()
out.push(`code=100 → ${codeRows.length}行 全て code に"100"を含む=${codeRows.every((c) => c.includes('100'))}`)
if (!codeRows.every((c) => c.includes('100'))) ok = false

// 0件(該当なし)の表示: 行は0、空の文言が出、done 文言は出さない
// (reset〜fetch の間は行が0でも「読み込み中…」が出るので、空文言が確定してから読む)
await page.getByPlaceholder('コードの一部を入力').fill('ZZZZ-NOTEXIST')
await page.waitForFunction(
  () =>
    document.querySelectorAll('.item-row').length === 0 &&
    document.body.textContent.includes('該当するレコードがありません'),
  { timeout: 6000 },
)
const emptyBody = await page.textContent('body')
out.push(`code=ZZZZ-NOTEXIST → 0行 / 空文言=${emptyBody.includes('該当するレコードがありません')} / done文言=${emptyBody.includes('最後まで表示しました')}`)
if (!emptyBody.includes('該当するレコードがありません') || emptyBody.includes('最後まで表示しました')) ok = false

// 行をタップすると照会結果(/result)へ client-side 遷移する(行全体がリンク)
await page.getByPlaceholder('コードの一部を入力').fill('1004')
await page.waitForFunction(
  () => document.querySelector('.item-row .item-code')?.textContent.trim() === '1004',
  { timeout: 6000 },
)
const rowLink = page.locator('.item-row').first().locator('a')
const rowHref = await rowLink.getAttribute('href')
const rowName = await rowLink.evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim())
// 行内の氏名側をタップしても遷移する(行まるごと当たり面积がある)
await rowLink.locator('.item-name').click()
await page.waitForFunction(() => location.pathname === '/result', { timeout: 5000 })

const card = await page.textContent('.result-card')
const statusTag = await page.locator('.result-tags .tag').first().textContent()
// 入金状況は見出しのタグだけを出す(詳細の行として重複表示しない)
const statusRows = await page.locator('.result-list .result-row', { hasText: '入金状況' }).count()
const cardOk =
  card.includes('渡辺健斗') &&
  card.includes('コード 1004') &&
  card.includes('9年') &&
  card.includes('5組') &&
  !!statusTag?.includes('未収') &&
  statusRows === 0
out.push(
  `行タップ(href=${rowHref} / 行のテキスト="${rowName}") → ${page.url()} カードに氏名=${card.includes('渡辺健斗')} code=${card.includes('コード 1004')} 年組=${card.includes('9年') && card.includes('5組')} 入金状況タグ="${statusTag?.trim()}" / 詳細の入金状況行=${statusRows}(0=重複なし)`,
)
if (!rowHref?.includes('/result?code=1004') || !cardOk) ok = false

// 金額・支払いは1つの枠に並ぶ(3桁区切り + 円)。この row には 入金額 が無いので2セル。
const moneyCells = await page.locator('.money-panel .panel-cell').evaluateAll((els) =>
  els.map((el) => ({
    text: el.textContent.replace(/\s+/g, ' ').trim(),
    // ラベルは .panel-label だけを見る(「購入金額」は "入金額" を部分文字列に含むので)
    label: el.querySelector('.panel-label')?.textContent?.trim() ?? '',
  })),
)
const moneyBoxCount = await page.locator('.money-panel').count()
const moneyLayout = await page.locator('.money-panel').evaluate((el) => el.className)
const moneyOk =
  moneyBoxCount === 1 &&
  moneyCells.length === 2 &&
  moneyCells[0].label === '購入金額' &&
  moneyCells[0].text.includes('2,700 円') &&
  moneyCells[1].label === '支払い方法' &&
  !moneyCells.some((c) => c.label === '入金額')
out.push(
  `金額枠=${moneyBoxCount}個 ${moneyCells.length}セル "${moneyCells.map((c) => c.text).join(' | ')}" layout="${moneyLayout}"(2,700 円形式)=${moneyOk}`,
)
if (!moneyOk) ok = false

// 商品と個数は1つの枠に星スロット(最大6個)+ 数字で並ぶ
const productCells = await page.locator('.product-panel .product-cell').evaluateAll((els) =>
  els.map((el) => ({
    text: el.textContent.replace(/\s+/g, ' ').trim(),
    slots: el.querySelector('.product-stars')?.textContent.length ?? 0,
    filled: el.querySelector('.star-on')?.textContent.length ?? 0,
    zero: el.classList.contains('zero'),
  })),
)
const productTitle = (await page.textContent('.product-panel .panel-title'))?.trim()
const starsOk = productCells.every((c) => c.slots === 6 && c.filled <= 6 && /\d+個/.test(c.text))
const filledSum = productCells.reduce((s, c) => s + c.filled, 0)
const countsSum = productCells.reduce((s, c) => s + Number(c.text.match(/(\d+)個/)?.[1] ?? 0), 0)
const productsOk =
  starsOk &&
  productCells.length === 7 &&
  filledSum === 11 &&
  countsSum === filledSum &&
  !!productTitle?.includes('合計 11個') &&
  !!productTitle?.includes('1商品あたり最大6個')
out.push(
  `商品枠=${productCells.length}行 "${productCells.map((c) => c.text).join(' | ')}" / 星スロット6個=${starsOk} / 埋まった星の和=${filledSum} / 数字の和=${countsSum} / 0個=${productCells.filter((c) => c.zero).length}行 / 見出し="${productTitle}"`,
)
if (!productsOk) ok = false

// 縦詰め: card が viewport(390×720)に収まり、結果だけでスクロールしない
const fits = await page.evaluate(() => {
  const el = document.querySelector('.result-card')
  if (!el) return { cardHeight: 0, cardBottom: 0, pageScrollable: false }
  const r = el.getBoundingClientRect()
  return {
    cardHeight: Math.round(r.height),
    cardBottom: Math.round(r.bottom),
    pageScrollable: document.documentElement.scrollHeight > window.innerHeight,
  }
})
out.push(
  `縦詰め: card=${fits.cardHeight}px(bottom=${fits.cardBottom} < viewport 720=${fits.cardBottom <= 720}) / ページ全体がスクロールする=${fits.pageScrollable}`,
)
if (fits.cardBottom > 720 || fits.cardHeight > 520 || fits.pageScrollable) ok = false

// 一覧に戻れる(スキャンに戻る / 一覧に戻る の2ボタン)
out.push(`戻るボタン: スキャンに戻る=${await page.getByRole('link', { name: 'スキャンに戻る' }).count()} / 一覧に戻る=${await page.getByRole('link', { name: '一覧に戻る' }).count()}`)
await page.getByRole('link', { name: '一覧に戻る' }).click()
await page.waitForFunction(() => location.pathname === '/items', { timeout: 5000 })
const backRows = await rowCount()
out.push(`一覧に戻る → ${page.url()} 行=${backRows}(0より大きい=${backRows > 0})`)
if (backRows <= 0) ok = false

out.push(`console warnings: ${warns.slice(0, 3).join(' | ') || '(none)'}`)
console.log(out.join('\n'))
console.log(`verdict: ${ok ? 'OK' : 'FAIL'}`)
await browser.close()
process.exit(ok ? 0 : 1)
