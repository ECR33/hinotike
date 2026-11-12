// ドットスタイル QR(qrcode-vue3 参考・既存 qrcode ライブラリ使用)の実測検証:
//  A) /share の SVG をブラウザでラスタ化し zxing(jsQR 系互換リーダー)でデコード → appLink と一致
//  B) /register のアプリ内スキャン(jsQR worker)に fakeカメラ代わりにドットQR(canvas)を流し
//     検出→parseRegistrationCode→依頼照会メッセージまで到達することを確認
// 使い方: node_modules/.bin/tsx scripts/verify-qr-style.mts [baseUrl]
import { chromium } from 'playwright-core'
import zxingPkg from '@zxing/library'
import QRCode from 'qrcode'
import { buildDotQrGeometry, QR_THEME } from '../shared/utils/qr-dots'

const { QRCodeReader, RGBLuminanceSource, BinaryBitmap, HybridBinarizer, DecodeHintType } = zxingPkg

const base = process.argv[2] ?? 'http://127.0.0.1:3000'

function hexLuma(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return Math.round(0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255))
}

function zxingDecode(lum: Uint8Array, px: number): string | null {
  const reader = new QRCodeReader(new Map([[DecodeHintType.TRY_HARDER, true]]))
  try {
    return reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, px, px)))).getText()
  } catch {
    return null
  }
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})
const page = await browser.newPage()
const results: Array<[string, unknown]> = []
const record = (name: string, value: unknown) => results.push([name, value])

const dumpResults = () => { for (const [name, value] of results) console.log(`${name}: ${JSON.stringify(value)}`) }

try {
// --- dev ログイン(登録済みユーザ dev@example.com) ---
await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'dev ログイン' }).click()
await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('QR'), { timeout: 15000 })

// --- A) /share: ドットSVGをラスタ化して zxing で読む ---
await page.locator('.bottom-nav .nav-item', { hasText: '管理' }).click()
await page.locator('.nav-menu .menu-item', { hasText: 'アプリ共有' }).click()
await page.waitForFunction(() => document.querySelector('.qr-svg'), { timeout: 10000 })
const appLink = (await page.locator('.page .mono').first().textContent())?.trim() ?? ''
const svgHtml = await page.locator('.qr-svg').first().evaluate((el) => el.outerHTML)

// ブラウザ内で SVG を 320px の白背景キャンバスに描いて輝度配列を取り出す(ジャギ込みの実描画)。
const lum = await page
  .evaluate((html) => {
    const img = new Image()
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(html)
    img.width = 320
    img.height = 320
    const px = 320
    const canvas = document.createElement('canvas')
    canvas.width = px
    canvas.height = px
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, px, px)
    ctx.drawImage(img, 0, 0, px, px)
    const d = ctx.getImageData(0, 0, px, px).data
    const out = new Uint8Array(px * px)
    for (let i = 0; i < px * px; i++) out[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2])
    return out
  }, svgHtml)
  .then((a) => Uint8Array.from(a))
record('A: appLink', appLink)
record('A: SVGラスタのzxingデコード', zxingDecode(lum, 320))

// --- B) /register: アプリ内スキャン(jsQR)でドットQRを検出 ---
await page.goto(`${base}/register`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => document.querySelector('video'), { timeout: 15000 })
await page.waitForTimeout(1500)

// 存在しない有効形式の registration token(依頼レコードなし→検出後に「見つかりません」系メッセージ)
const token = 'hinotike-registration:dead0000-1111-2222-3333-444455556666'
const qr = await QRCode.create(token, { errorCorrectionLevel: 'M' })
const geom = buildDotQrGeometry(qr, { finderStyle: 'rounded' })
// 注: evaluate 内で関数定義(tsx の keepNames が __name を注入)は ReferenceError になるため、
// ラスタは Node 側で計算し、ページ内では putImageData + captureStream だけ行う。
const dims = await page.evaluate(() => {
  const video = document.querySelector('video')!
  return { w: video.videoWidth || 640, h: video.videoHeight || 480 }
})
const side = Math.floor(Math.min(dims.w, dims.h) * 0.5) // libraryScanRegion(frac 0.5) の中央枠
const m = Math.max(2, Math.floor(side / geom.dim))
const offX = Math.floor((dims.w - geom.dim * m) / 2)
const offY = Math.floor((dims.h - geom.dim * m) / 2)

const rr = (u: number, v: number, cx: number, cy: number, half: number, rx: number) => {
  const dx = Math.abs(u - cx), dy = Math.abs(v - cy)
  if (dx > half || dy > half) return false
  if (dx <= half - rx || dy <= half - rx) return true
  const ex = dx - (half - rx), ey = dy - (half - rx)
  return ex * ex + ey * ey <= rx * rx
}
const dotLuma = hexLuma(QR_THEME.dotColor)
const finderLuma = hexLuma(QR_THEME.finderColor)
const camLum = new Uint8Array(dims.w * dims.h).fill(255)
let dark = 0
let regionDark = 0
for (let py = offY; py < offY + geom.dim * m; py++) {
  for (let pxx = offX; pxx < offX + geom.dim * m; pxx++) {
    const u = (pxx - offX + 0.5) / m
    const v = (py - offY + 0.5) / m
    let isDark = false
    let isFinder = false
    for (const f of geom.finders) {
      if (Math.abs(u - f.cx) > 4 || Math.abs(v - f.cy) > 4) continue
      isDark = rr(u, v, f.cx, f.cy, 3.5, 1.2) || rr(u, v, f.cx, f.cy, 1.5, 0.8)
      if (isDark) { isFinder = true; break }
    }
    if (!isDark) {
      const mx = Math.floor(u - geom.margin), my = Math.floor(v - geom.margin)
      if (mx >= 0 && my >= 0 && mx < geom.size && my < geom.size && qr.modules.get(mx, my)) {
        const dx = u - (mx + geom.margin + 0.5), dy = v - (my + geom.margin + 0.5)
        if (dx * dx + dy * dy <= 0.34 * 0.34) isDark = true
      }
    }
    if (isDark) {
      dark++
      if (pxx >= (dims.w - side) / 2 && pxx < (dims.w + side) / 2 && py >= (dims.h - side) / 2 && py < (dims.h + side) / 2) regionDark++
      camLum[py * dims.w + pxx] = isFinder ? finderLuma : dotLuma
    }
  }
}

await page.evaluate((p) => {
  const video = document.querySelector('video')!
  const canvas = document.createElement('canvas')
  canvas.width = p.w
  canvas.height = p.h
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(p.w, p.h)
  for (let i = 0; i < p.lum.length; i++) {
    img.data[i * 4] = p.lum[i]
    img.data[i * 4 + 1] = p.lum[i]
    img.data[i * 4 + 2] = p.lum[i]
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  video.srcObject = canvas.captureStream(10)
  void video.play?.()?.catch?.(() => {})
}, { w: dims.w, h: dims.h, lum: camLum })
const stats = { dark, regionDark, m, dim: geom.dim }
// 注入直後のフレーム実測(video から1フレーム取り出し、中央枠内の暗/明ピクセルを数える)
const frameStats = await page.evaluate((p) => {
  const video = document.querySelector('video')!
  const canvas = document.createElement('canvas')
  canvas.width = p.w
  canvas.height = p.h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(video, 0, 0, p.w, p.h)
  const d = ctx.getImageData(0, 0, p.w, p.h).data
  let dark = 0
  let mid = 0
  const side = Math.floor(Math.min(p.w, p.h) * 0.5)
  const x0 = Math.floor((p.w - side) / 2)
  const y0 = Math.floor((p.h - side) / 2)
  for (let py = y0; py < y0 + side; py++) {
    for (let pxx = x0; pxx < x0 + side; pxx++) {
      const i = (py * p.w + pxx) * 4
      const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
      if (luma < 120) dark++
      else if (luma > 200) mid++
    }
  }
  const track = video.srcObject?.getVideoTracks?.()?.[0]
  return { readyState: video.readyState, trackKind: track?.kind ?? null, dark, mid, side }
}, dims)
record('B: 注入後フレーム実測(中央枠)', frameStats)

// 検出→parseRegistrationCode→依頼照会結果のメッセージが出るまで待つ
const message = await page
  .waitForFunction(() => {
    const el = document.querySelector('.page .message, .page .error, .page .ok, .page .card p:not(.muted)')
    return el && el.textContent && el.textContent.length > 0 ? el.textContent : null
  }, { timeout: 15000 })
  .then((h) => h.textContent())
record('B: 検出後のメッセージ', message)
} catch (e) {
  dumpResults()
  console.error('FAILED:', (e as Error).message)
  await browser.close()
  process.exit(1)
}

const verdict =
  results.every(([, v]) => v !== null && v !== undefined && v !== false && v !== 0) &&
  zxingDecode(lum, 320) === appLink &&
  stats.regionDark > 0 &&
  message !== null
record('verdict', verdict ? 'OK' : 'FAIL')

dumpResults()
await browser.close()
process.exit(verdict ? 0 : 1)
