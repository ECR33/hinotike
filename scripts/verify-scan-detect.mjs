// /scan の検出(標準UIの連続スキャン)に fakeカメラの代わりにQR画像(canvas.captureStream)を流し、
// 中央枠のQRのみが検出されること(隣のQRは無視)を実測する検証。
// 中央コードは実データ 1004(渡辺健斗)、左右は存在しないコード。
// 使い方: node scripts/verify-scan-detect.mjs [baseUrl]
import { chromium } from 'playwright-core'
import pkg from '@zxing/library'
const { QRCodeWriter, BarcodeFormat } = pkg

const base = process.argv[2] ?? 'http://127.0.0.1:3000'

function matrixData(text) {
  const m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 100, 100, new Map())
  const data = []
  for (let y = 0; y < m.getHeight(); y++) {
    for (let x = 0; x < m.getWidth(); x++) data.push(m.get(x, y) ? 1 : 0)
  }
  return data
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})
const page = await browser.newPage()

await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'dev ログイン' }).click()
await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('QR'), { timeout: 10000 })
// fakeカメラの解像度でスキャン中になるまで待つ(canvasの解像度をそれに合わせるため)
await page.waitForFunction(
  () => document.querySelector('.muted')?.textContent?.includes('スキャン中'),
  { timeout: 10000 },
)

const codes = { center: matrixData('1004'), left: matrixData('NOPE-LEFT'), right: matrixData('NOPE-RIGHT') }

// 検出がevaluate中に完成すると(エンジンが速い)遷移でexecution contextが壊れる。
// injection自体は同期で完了しているので無視して続きを待つ。
await page.evaluate((c) => {
  const video = document.querySelector('video')
  const w = video.videoWidth || 640
  const h = video.videoHeight || 480
  // libraryScanRegion(frac=0.5) の中央正方形(side = 短辺の半分)に中央QRを収め、
  // 左右QRはその枠の外(x=0 / x=w-side)に配置する。
  const side = Math.floor(Math.min(w, h) * 0.5)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#000'
  const top = Math.floor((h - side) / 2)
  // モジュールサイズは整数(px)にしてジャギ/アンチエイリアスを避け、QRを中央枠に配置する。
  // 中央QR: 100*m px を画像中央(=中央枠の中心)に配置(m = floor(side/100))。
  // 左右QR: 同じ大きさで画像の左右端に配置し、中央枠の真外に置く。
  const m = Math.max(2, Math.floor(side / 100))
  const qrPx = 100 * m
  const draw = (data, offsetX, offsetY) => {
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        if (data[y * 100 + x]) ctx.fillRect(offsetX + x * m, offsetY + y * m, m, m)
      }
    }
  }
  draw(c.left, 0, Math.floor((h - qrPx) / 2))
  draw(c.center, Math.floor((w - qrPx) / 2), Math.floor((h - qrPx) / 2))
  draw(c.right, w - qrPx, Math.floor((h - qrPx) / 2))
  video.srcObject = canvas.captureStream(10)
  void video.play?.()?.catch?.(() => {})
}, codes).catch(() => console.log('evaluate was interrupted by navigation(engine detected immediately)'))

let ok = false
try {
  await page.waitForFunction(() => location.search.includes('code=1004'), { timeout: 15000 })
  // 結果カードのフェッチ完了まで待つ(遷移直後のテキストは空になり得る)
  await page.waitForFunction(
    () => document.querySelector('.result-card')?.textContent?.includes('渡辺健斗'),
    { timeout: 10000 },
  ).catch(() => {})
  ok = true
} catch {
  console.log(`FAIL: 遷移URL=${page.url()} / 画面=${(await page.textContent('body').catch(() => '')).slice(0, 120)}`)
}
const listText = ok ? await page.textContent('.result-card').catch(() => '') : ''
console.log(`detected url: ${page.url()}`)
console.log(`result shows 渡辺健斗: ${listText.includes('渡辺健斗')}`)
console.log(ok && listText.includes('渡辺健斗') ? 'verdict: OK(中央枠のQRのみ検出・実データ表示)' : 'verdict: FAIL')
await browser.close()
process.exit(ok && listText.includes('渡辺健斗') ? 0 : 1)
