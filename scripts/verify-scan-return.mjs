// 照会スキャン → 結果画面 → 「スキャンに戻る」でカメラが自動再開するかを実測する検証。
// (照会モードは検出1回で stop して /result へ遷移する。戻ったときに開始ボタンをもう1回
//  押させると、照会→結果の往復ごとにタップが増える。QrScanner は自動再開する。)
// 「スキャン停止」ボタンで止めた場合はユーザーの意思なので再開しないことも確認する。
// 戻った直後に手元の同じQRを再読して「戻る → 即結果」の往復にならないことも確認する
// (照会モードも isSameScan の2.5秒窓で重複除外する)。
// 読み取り音(「ピッ」)も同時に確認する: 検出成功で1音、窓内再読では増えない、
// 管理欄の静音スイッチ OFF では読めても鳴らない、ON に戻すと鳴る。
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

// 読み取り音(Web Audio 合成)を数えるため、AudioContext の oscillator をラップする。
// ヘッドレスでは実音の出力を確認できないが、oscillator.start が呼ばれた=音を出した、が見える。
await page.addInitScript(() => {
  window.__beeps = 0
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return
  const create = AC.prototype.createOscillator
  AC.prototype.createOscillator = function () {
    const osc = create.call(this)
    const start = osc.start.bind(osc)
    osc.start = (...args) => {
      window.__beeps += 1
      return start(...args)
    }
    return osc
  }
})
const beepCount = () => page.evaluate(() => (window.__beeps ?? 0))
/** 管理欄(details)を開く。summary を click すると開いているときは閉じるので、open を直接立てる。 */
const openAdmin = () => page.locator('.admin-card').evaluate((el) => { el.open = true })

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
  // 1件目を読んだときに「ピッ」が1回だけ鳴った(音は検出成功の合図なので、遷移しても音は増えない)
  console.log(`1件目の読み取り音: ${await beepCount()}音`)
  if ((await beepCount()) !== 1) failures.push('1件目の読み取りで「ピッ」が1回鳴らない')

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
  // 窓内の再読は「読めた」ではないので音も増えない(誤読・再読でピッピッ鳴らない)
  if ((await beepCount()) !== 1) failures.push('同じQRの窓内再読で音が増えた(読み取り成功以外で鳴っている)')
  await drawBlank()

  // 別のQRはそのまま読める(開始ボタンを押さずに)
  await drawCode(SECOND)
  await page
    .waitForFunction((code) => location.pathname === '/result' && location.search.includes(code), SECOND, { timeout: 20000 })
    .catch(() => failures.push(`戻った後に 2件目(${SECOND})が読めない`))
  console.log(`2件目の照会結果: ${await page.evaluate(() => location.search)}`)
  await drawBlank()
  console.log(`2件目の読み取り音: ${await beepCount()}音(計)`)
  if ((await beepCount()) !== 2) failures.push('2件目の読み取りで「ピッ」が増えない')

  // 静音スイッチ(管理欄)を OFF にすると、読めても鳴らない
  await page.getByRole('link', { name: 'スキャンに戻る' }).click()
  await page.waitForFunction(() => location.pathname === '/scan', undefined, { timeout: 15000 })
  await page.waitForFunction(scannerRunning(), undefined, { timeout: 15000 }).catch(() => failures.push('静音テスト前に再開していない'))
  await openAdmin()
  await page.getByRole('button', { name: /^読み取り音/ }).click()
  console.log(`静音スイッチ: ${(await page.textContent('body').catch(() => '')).match(/読み取り音: (ON|OFF)/)?.[0] ?? ''}`)
  await drawCode(FIRST)
  await page
    .waitForFunction((code) => location.pathname === '/result' && location.search.includes(code), FIRST, { timeout: 20000 })
    .catch(() => failures.push('静音(OFF)にしても読み取り自体が効かない'))
  await drawBlank()
  const mutedBeeps = await beepCount()
  console.log(`静音後の読み取り音: ${mutedBeeps}音(増えないはず)`)
  if (mutedBeeps !== 2) failures.push('静音(OFF)でも音が鳴る(読み取り音スイッチが効いていない)')
  // ON に戻して鳴ることを確認(次の実行や実使用で既定 ON のままにする)
  await page.getByRole('link', { name: 'スキャンに戻る' }).click()
  await page.waitForFunction(() => location.pathname === '/scan', undefined, { timeout: 15000 })
  await page.waitForFunction(scannerRunning(), undefined, { timeout: 15000 }).catch(() => failures.push('静音解除前に再開していない'))
  await openAdmin()
  await page.getByRole('button', { name: /^読み取り音/ }).click()
  await drawCode(SECOND)
  await page
    .waitForFunction((code) => location.pathname === '/result' && location.search.includes(code), SECOND, { timeout: 20000 })
    .catch(() => failures.push('静音解除後に読み取りが効かない'))
  await drawBlank()
  console.log(`静音解除後の読み取り音: ${await beepCount()}音(3音目)`)
  if ((await beepCount()) !== 3) failures.push('静音解除後に「ピッ」が鳴らない')

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
