// 照会スキャン → 結果画面 → 「スキャンに戻る」でカメラが自動再開するかを実測する検証。
// (照会モードは検出1回で stop して /result へ遷移する。戻ったときに開始ボタンをもう1回
//  押させると、照会→結果の往復ごとにタップが増える。QrScanner は自動再開する。)
// 「スキャン停止」ボタンで止めた場合はユーザーの意思なので再開しないことも確認する。
// 戻った直後に手元の同じQRを再読して「戻る → 即結果」の往復にならないことも確認する
// (照会モードも isSameScan の2.5秒窓で重複除外する)。
//
//   node scripts/verify-scan-return.mjs [baseUrl]
//
// カメラは `navigator.mediaDevices.getUserMedia` を canvas の stream に差し替える
// (ライブラリが start 時に自分で srcObject を置くので、後から付け直す競合を避けられる)。
// stream は stop(teardown)で track が stop されるため、getUserMedia ごとに新しい stream を作る。
import { chromium } from 'playwright-core'
import pkg from '@zxing/library'

const { QRCodeWriter, BarcodeFormat } = pkg

const base = process.argv[2] ?? 'http://127.0.0.1:3000'
const FIRST = '1004' // 渡辺健斗
const SECOND = '1018' // 田中桔平

function matrixData(text) {
  const m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 100, 100, new Map())
  const data = []
  for (let y = 0; y < m.getHeight(); y++) for (let x = 0; x < m.getWidth(); x++) data.push(m.get(x, y) ? 1 : 0)
  return data
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 140)}`)
})

await page.addInitScript(() => {
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  window.__qrCanvas = canvas
  // スキャン停止で srcObject の track が stop されるので、取得ごとに新しい stream を返す
  // (再利用した ended stream だと映像が流れず play() が完了しない)。
  navigator.mediaDevices.getUserMedia = () => Promise.resolve(canvas.captureStream(10))
})

async function drawCode(text) {
  const data = matrixData(text)
  await page.evaluate((d) => {
    const canvas = window.__qrCanvas
    const w = canvas.width
    const h = canvas.height
    const ctx = canvas.getContext('2d')
    const m = Math.max(2, Math.floor(Math.min(w, h) * 0.5 / 100))
    const qrPx = 100 * m
    function draw() {
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#000'
      for (let y = 0; y < 100; y++) {
        for (let x = 0; x < 100; x++) {
          if (d[y * 100 + x]) ctx.fillRect(Math.floor((w - qrPx) / 2) + x * m, Math.floor((h - qrPx) / 2) + y * m, m, m)
        }
      }
      // captureStream は canvas が変更されたときだけフレームを出す(静的画像だと枚数が少ない)。
      // QRの枠の外(左上の余白)に毎回1点置いてフレーム生成を続け、単発描画でのflakyさを避ける。
      ctx.fillStyle = '#000'
      ctx.fillRect(4 + ((Date.now() / 7) | 0) % Math.max(1, Math.floor((w - qrPx) / 2) - 8), 4 + ((Date.now() / 11) | 0) % 8, 2, 2)
    }
    if (window.__qrTick) clearInterval(window.__qrTick)
    draw()
    window.__qrTick = setInterval(draw, 180)
  }, data)
}

/** QRなしの「白い枠 + 動く点」を描き続ける(検出しないが映像は流れ続ける)。
 * captureStream は canvas の変更時だけフレームを出すので、静止画だと video が再生されず
 * スキャナーの start() が完了しない(= 検証の待機が失敗する)。 */
async function drawBlank() {
  await page.evaluate(() => {
    if (window.__qrTick) clearInterval(window.__qrTick)
    const canvas = window.__qrCanvas
    const w = canvas.width
    const h = canvas.height
    const ctx = canvas.getContext('2d')
    function draw() {
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#000'
      ctx.fillRect(4 + ((Date.now() / 7) | 0) % (w - 12), 4 + ((Date.now() / 11) | 0) % (h - 12), 6, 6)
    }
    draw()
    window.__qrTick = setInterval(draw, 180)
  })
}

const scanningText = () => () =>
  [...document.querySelectorAll('.muted')].map((p) => p.textContent ?? '').join(' | ').includes('スキャン中')
const scannerRunning = () => () => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'スキャン停止')
const framesReady = () => () => {
  const v = document.querySelector('video')
  return !!v && v.videoWidth > 0 && v.readyState >= 2
}

const failures = []
try {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'dev ログイン' }).click()
  await page.waitForFunction(() => location.pathname === '/scan', { timeout: 15000 })
  await drawBlank()
  await page.waitForFunction(scannerRunning(), undefined, { timeout: 15000 }).catch(() =>
    failures.push('初期の /scan でスキャンが開始されていない'),
  )
  await page.waitForFunction(framesReady(), undefined, { timeout: 15000 }).catch(() =>
    failures.push('初期の /scan で映像が流れない'),
  )

  // 照会(モードチップの「照会」)= 検出1回で /result へ
  await page.getByRole('button', { name: '照会' }).click()
  await page.waitForFunction(scanningText(), undefined, { timeout: 15000 })
  await page.waitForFunction(framesReady(), undefined, { timeout: 15000 })

  await drawCode(FIRST)
  await page
    .waitForFunction((code) => location.pathname === '/result' && location.search.includes(code), FIRST, { timeout: 20000 })
    .catch(() => failures.push(`1件目の照会結果(/result?code=${FIRST})に届かない`))
  await drawBlank()

  await page.getByRole('link', { name: 'スキャンに戻る' }).click()
  await page.waitForFunction(() => location.pathname === '/scan', undefined, { timeout: 15000 })
  // 開始ボタンを押さずにスキャナーが再開されているか(再マウント + 自動起動)
  await page.waitForFunction(scannerRunning(), undefined, { timeout: 15000 }).catch(() =>
    failures.push('戻った後にカメラが再開していない(開始ボタンが必要になっている)'),
  )
  await page.waitForFunction(scanningText(), undefined, { timeout: 15000 }).catch(() =>
    failures.push('戻った後に「スキャン中」の表示が出ない'),
  )
  await page.waitForFunction(framesReady(), undefined, { timeout: 15000 }).catch(() =>
    failures.push('戻った後に映像が流れない(再マウント失敗 or 開始ボタンが必要)'),
  )
  console.log(
    `戻った後の状態: ${await page.evaluate(() => [...document.querySelectorAll('.muted')].map((p) => p.textContent ?? '').join(' | ').slice(0, 120))}`,
  )

  // 同じQRを窓内で再読しても「戻る → 即結果」の往復にならない(2.5秒窓で重複除外)
  await drawCode(FIRST)
  await page.waitForTimeout(2000)
  if (page.url().includes('/result')) {
    failures.push('戻った直後に同じQRを再読して /result に戻ってしまった(窓内の重複除外が効いていない)')
  } else {
    console.log('戻った直後に同じQRを2秒映した: /scan のまま(窓内の再読は無視)')
  }
  await drawBlank()

  // 別のQRはそのまま読める(開始ボタンを押さずに)
  await drawCode(SECOND)
  await page
    .waitForFunction((code) => location.pathname === '/result' && location.search.includes(code), SECOND, { timeout: 20000 })
    .catch(() => failures.push(`戻った後に 2件目(${SECOND})が読めない`))
  console.log(`2件目の照会結果: ${await page.evaluate(() => location.search)}`)
  await drawBlank()

  // ユーザーの停止(スキャン停止ボタン)は自動再開しない
  await page.getByRole('link', { name: 'スキャンに戻る' }).click()
  await page.waitForFunction(() => location.pathname === '/scan', undefined, { timeout: 15000 })
  await page.waitForFunction(scannerRunning(), undefined, { timeout: 15000 }).catch(() => failures.push('戻った後に再開していない'))
  await page.getByRole('button', { name: 'スキャン停止' }).click()
  const stoppedText = () => () => [...document.querySelectorAll('.muted')].map((p) => p.textContent ?? '').join(' | ').includes('停止しました')
  await page.waitForFunction(stoppedText(), undefined, { timeout: 10000 }).catch(() =>
    failures.push('スキャン停止ボタンで止まらない(「停止しました」の表示が出ない)'),
  )
  await page.getByRole('link', { name: '一覧' }).click()
  await page.waitForFunction(() => location.pathname === '/items', undefined, { timeout: 15000 })
  await page.getByRole('link', { name: 'QRスキャン' }).click()
  await page.waitForFunction(() => location.pathname === '/scan', undefined, { timeout: 15000 })
  const stillStopped = await page.evaluate(() => ![...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'スキャン停止'))
  console.log(`スキャン停止後に画面を戻った状態: ${stillStopped ? '停止のまま(ユーザーの停止意思を尊重)' : '自動再開した(意図と違い)'}`)
  if (!stillStopped) failures.push('「スキャン停止」後に画面を戻ったら自動再開した(ユーザーの停止は尊重すべき)')
} catch (e) {
  failures.push(`例外: ${e instanceof Error ? e.message : String(e)}`)
}
if (errors.length) failures.push(`画面エラー: ${errors.join(' | ')}`)
if (failures.length) {
  console.log(`FAIL: ${failures.join(' / ')}`)
  console.log(`画面=${(await page.textContent('body').catch(() => '')).slice(0, 200)}`)
}
console.log(`verdict: ${failures.length === 0 ? 'OK(戻り後の自動再開・窓内の再読重複除外・ユーザーの意思での停止は再開しない)' : 'FAIL'}`)
await browser.close()
process.exit(failures.length === 0 ? 0 : 1)
