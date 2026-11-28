// keepalive の /scan から画面を遷移したときにカメラが裏で動き続けていないかを実測する検証。
// /scan は `keepalive: true` なので遷移しても unmount されず deactivate されるだけ。
// onBeforeUnmount が走らないため、以前は MediaStream の track が live のまま(カメラが裏で
// 映像を取り続けていた)。router.beforeEach の遷移 guard で QrScanner を stop する修正の回帰用。
//
//   node scripts/verify-scan-leave.mjs [baseUrl]
//
// 確認する内容:
//  1. /scan にいる間: getUserMedia の stream が live(スキャンが動いている)
//  2. /items へ遷移後: すべての track が ended(カメラが停止した)
//  3. /scan に戻った後: 自動再開される(track が live + 「スキャン停止」ボタンが出る)
//  4. 記録モード(連続)で遷移中にQRを映しても、隠れた画面で読み取りが積み上がらない
//     (読み取り音が増えない / 戻った後のセッション件数は去る直前と同じ)
// カメラは `navigator.mediaDevices.getUserMedia` を canvas の stream に差し替える(他 verify と同じ)。
import { chromium } from 'playwright-core'
import pkg from '@zxing/library'

const { QRCodeWriter, BarcodeFormat } = pkg

const base = process.argv[2] ?? 'http://127.0.0.1:3000'
const FIRST = '1004' // 渡辺健斗

function matrixData(text) {
  const m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 100, 100, new Map())
  const data = []
  for (let y = 0; y < m.getHeight(); y++) for (let x = 0; x < m.getWidth(); x++) data.push(m.get(x, y) ? 1 : 0)
  return data
}

const failures = []

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') failures.push(`console: ${m.text().slice(0, 140)}`)
})

await page.addInitScript(() => {
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  window.__qrCanvas = canvas
  window.__streams = []
  navigator.mediaDevices.getUserMedia = async () => {
    const stream = canvas.captureStream(10)
    window.__streams.push(stream)
    return stream
  }
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
      // captureStream は canvas が変更されたときだけフレームを出す(静的画像だと映像が流れない)
      ctx.fillStyle = '#000'
      ctx.fillRect(4 + ((Date.now() / 7) | 0) % Math.max(1, Math.floor((w - qrPx) / 2) - 8), 4 + ((Date.now() / 11) | 0) % 8, 2, 2)
    }
    if (window.__qrTick) clearInterval(window.__qrTick)
    draw()
    window.__qrTick = setInterval(draw, 180)
  }, data)
}

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

// ページ内で実行する述語(waitForFunction / evaluate にそのまま渡せる)。page を参照しない。
const liveFn = () => window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length
const runningFn = () => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'スキャン停止')

// 読み取り音(Web Audio 合成)を数える(検出成功の合図。隠れた画面で鳴らないことを確認する)
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

try {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'dev ログイン' }).click()
  await page.waitForFunction(() => location.pathname === '/scan', { timeout: 15000 })
  await drawBlank()
  await page.waitForFunction(runningFn, undefined, { timeout: 15000 }).catch(() =>
    failures.push('/scan でスキャンが開始されていない'),
  )
  await page.waitForFunction(() => window.__streams.flatMap((s) => s.getTracks()).some((t) => t.readyState === 'live'), undefined, { timeout: 15000 }).catch(() =>
    failures.push('/scan でカメラ(getUserMedia)が起動しない'),
  )
  console.log(`/scan にいる間: live track ${await page.evaluate(liveFn)}本`)

  // 照合は端末ミラーが読むので先に取り込む(記録モードの読み取り音の確認用)
  await page.getByRole('group', { name: '作業するデータセット' }).getByRole('button', { name: 'このデータを端末に取り込む' }).click()
  await page.waitForFunction(() => document.body.textContent?.includes('取り込み完了'), { timeout: 60000 })

  // 記録モード(連続): 検出しても止めない状態のまま遷移する
  await page.getByRole('group', { name: 'スキャンのモード' }).getByRole('button', { name: 'チケット配布' }).click()
  await page.waitForFunction(runningFn, undefined, { timeout: 15000 })
  await drawCode(FIRST)
  await page.waitForFunction(() => window.__beeps > 0, undefined, { timeout: 20000 }).catch(() =>
    failures.push('記録モード(/scan 上)でQRが読めない(前提の状態作りに失敗)'),
  )
  const beepsOnScan = await page.evaluate(() => window.__beeps)
  // 去る直前のセッションの読み取り件数(記録+重複+問題+未確定。戻った後に増えていないことを
  // 隠れた読み取りの判定に使う — 未確定はオフラインでは確定するまで「記録」側に出ないため)
  const sessionTotal = () => {
    const el = document.querySelector('.session-card')
    const m = el?.textContent?.match(/記録 (\d+)件 \/ 重複 (\d+)件 \/ 問題 (\d+)件 \/ 未確定 (\d+)件/)
    return m ? Number(m[1]) + Number(m[2]) + Number(m[3]) + Number(m[4]) : -1
  }
  const sessionBefore = await page.evaluate(sessionTotal)

  // /items へ遷移(keepalive の /scan は deactivate されるだけ)
  await page.getByRole('link', { name: '一覧' }).click()
  await page.waitForFunction(() => location.pathname === '/items', { timeout: 15000 })
  await page.waitForTimeout(1500)
  const liveAfterLeave = await page.evaluate(liveFn)
  console.log(`/items に遷移後: live track ${liveAfterLeave}本`)
  if (liveAfterLeave > 0) failures.push('画面を遷移した後もカメラの track が live(裏で動いている)')

  // 隠れた画面でQRを映し続けても読み取りは積み上がらない(音が増えない)
  await page.waitForTimeout(2500)
  const beepsHidden = await page.evaluate(() => window.__beeps)
  console.log(`遷移中にQRを映し続けた: 音 ${beepsOnScan}→${beepsHidden}音(増えないはず)`)
  if (beepsHidden !== beepsOnScan) failures.push('画面を隠した後も読み取りが続いている(音が増えた)')

  // /scan に戻ると自動再開する(遷移時の stop はユーザーの停止ではない)
  await page.getByRole('link', { name: 'QRスキャン' }).click()
  await page.waitForFunction(() => location.pathname === '/scan', { timeout: 15000 })
  await drawBlank() // 戻った直後に映っているQRを即読まないよう先に空白へ替える
  await page.waitForTimeout(2000)
  const liveAfterReturn = await page.evaluate(liveFn)
  console.log(`/scan に戻った後: live track ${liveAfterReturn}本`)
  if (liveAfterReturn === 0) failures.push('戻った後にカメラが再開していない')
  if (!(await page.evaluate(runningFn))) failures.push('戻った後に「スキャン停止」ボタンが出ない(再開していない)')
  // 隠れている間の読み取りはセッションに積まれていない(戻った後の件数 = 去る直前の件数)
  const sessionAfter = await page.evaluate(sessionTotal)
  console.log(`セッション件数(記録+重複+問題+未確定): 去る直前 ${sessionBefore}件 → 戻った後 ${sessionAfter}件(増えないはず)`)
  if (sessionAfter !== sessionBefore) failures.push('隠れた画面での読み取りがセッションに積み上がった(件数が増えた)')
} catch (e) {
  failures.push(`例外: ${e instanceof Error ? e.message : String(e)}`)
}
if (failures.length) {
  console.log(`FAIL: ${failures.join(' / ')}`)
  console.log(`画面=${(await page.textContent('body').catch(() => '')).slice(0, 200)}`)
}
console.log(`verdict: ${failures.length === 0 ? 'OK(遷移でカメラ停止・戻りで自動再開・隠れた画面では読まない)' : 'FAIL'}`)
await browser.close()
process.exit(failures.length === 0 ? 0 : 1)
