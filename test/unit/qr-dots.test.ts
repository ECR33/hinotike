/**
 * ドットスタイル QR の幾何(qr-dots.ts)と、幾何からラスタ化した輝度画像が
 * jsQR/zxing 系のリーダーでデコードできることを検証する unit test。
 *
 * ラスタは「1 byte/pixel の輝度配列」を @zxing の RGBLuminanceSource に渡す。
 * unit 座標は u=(pxx+0.5)*(dim/px)(割算ではない: scale=dim/px を掛ける)。
 */
import { describe, it, expect } from 'vitest'
import QRCode from 'qrcode'
import zxingPkg from '@zxing/library'
import { buildDotQrGeometry, QR_THEME, type DotQrGeometry, type DotQrTheme } from '../../shared/utils/qr-dots'

const { QRCodeReader, RGBLuminanceSource, BinaryBitmap, HybridBinarizer, DecodeHintType } = zxingPkg

function hexLuma(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b)
}

function roundedRectContains(u: number, v: number, cx: number, cy: number, half: number, rx: number): boolean {
  const dx = Math.abs(u - cx)
  const dy = Math.abs(v - cy)
  if (dx > half || dy > half) return false
  if (dx <= half - rx || dy <= half - rx) return true
  const ex = dx - (half - rx)
  const ey = dy - (half - rx)
  return ex * ex + ey * ey <= rx * rx
}

/** 幾何から px x px の輝度配列(1 byte/pixel)を描く。ジャギなしの解析描画。 */
function rasterizeDotQr(geom: DotQrGeometry, theme: DotQrTheme, px: number): Uint8Array {
  const lum = new Uint8Array(px * px)
  const bg = hexLuma(theme.background)
  const dotLuma = hexLuma(theme.dotColor)
  const finderLuma = hexLuma(theme.finderColor)
  const darkModules = new Set(geom.dots.map((d) => `${d.cx - geom.margin - 0.5},${d.cy - geom.margin - 0.5}`))
  const scale = geom.dim / px

  for (let py = 0; py < px; py++) {
    const v = (py + 0.5) * scale
    for (let pxx = 0; pxx < px; pxx++) {
      const u = (pxx + 0.5) * scale
      let luma = bg

      // finder(7x7 block の中心から annulus + 内部正方形)
      for (const f of geom.finders) {
        if (Math.abs(u - f.cx) > 4 || Math.abs(v - f.cy) > 4) continue
        const band =
          roundedRectContains(u, v, f.cx, f.cy, 3.5, 1.2) && !roundedRectContains(u, v, f.cx, f.cy, 2.5, 1)
        const inner = roundedRectContains(u, v, f.cx, f.cy, 1.5, 0.8)
        if (band || inner) {
          luma = finderLuma
          break
        }
      }

      // データドット(module 中心の円)
      if (luma === bg) {
        const mx = Math.floor(u - geom.margin)
        const my = Math.floor(v - geom.margin)
        if (mx >= 0 && my >= 0 && mx < geom.size && my < geom.size && darkModules.has(`${mx},${my}`)) {
          const dx = u - (mx + geom.margin + 0.5)
          const dy = v - (my + geom.margin + 0.5)
          if (dx * dx + dy * dy <= 0.34 * 0.34) luma = dotLuma
        }
      }

      lum[py * px + pxx] = luma
    }
  }
  return lum
}

function zxingDecode(lum: Uint8Array, px: number): string | null {
  const reader = new QRCodeReader(new Map([[DecodeHintType.TRY_HARDER, true]]))
  try {
    return reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, px, px)))).getText()
  } catch {
    return null
  }
}

async function dotGeom(text: string): Promise<DotQrGeometry> {
  const qr = await QRCode.create(text, { errorCorrectionLevel: 'M' })
  return buildDotQrGeometry(qr, { finderStyle: 'rounded' })
}

describe('buildDotQrGeometry', () => {
  it('dim は size + margin*2 で quiet zone を含む', async () => {
    const geom = await dotGeom('http://localhost:3000')
    expect(geom.dim).toBe(geom.size + 4)
    expect(geom.margin).toBe(2)
  })

  it('finder の中心は3つの 7x7 block の中心', async () => {
    const geom = await dotGeom('http://localhost:3000')
    expect(geom.finders.length).toBe(3)
    expect(geom.finders[0]).toMatchObject({ cx: 5.5, cy: 5.5 })
    expect(geom.finders[1]).toMatchObject({ cx: geom.size + 2 - 3.5, cy: 5.5 })
    expect(geom.finders[2]).toMatchObject({ cx: 5.5, cy: geom.size + 2 - 3.5 })
  })

  it('ドットは finder block(7x7)の内側に置かない', async () => {
    const text = 'http://localhost:3000'
    const geom = await dotGeom(text)
    for (const d of geom.dots) {
      const mx = d.cx - geom.margin - 0.5
      const my = d.cy - geom.margin - 0.5
      const inTop = my <= 6
      const inBottom = my >= geom.size - 7
      const side = mx <= 6 || mx >= geom.size - 7
      // 左上/右上(top 行の左右)と左下(bottom 行の左側)の block を除外
      expect((inTop && side) || (inBottom && mx <= 6)).toBe(false)
    }
    // 暗モジュールの finder 分(3 block の実データ部分)は描画から消えている
    const qr = await QRCode.create('http://localhost:3000', { errorCorrectionLevel: 'M' })
    let darkOutside = 0
    for (let y = 0; y < qr.modules.size; y++) {
      for (let x = 0; x < qr.modules.size; x++) {
        if (!qr.modules.get(x, y)) continue
        const inTop = y <= 6
        const inBottom = y >= qr.modules.size - 7
        const side = x <= 6 || x >= qr.modules.size - 7
        if ((inTop && side) || (inBottom && x <= 6)) continue
        darkOutside++
      }
    }
    expect(geom.dots.length).toBe(darkOutside)
  })
})

describe('dot QR の zxing(jsQR 系リーダー互換)デコード', () => {
  it('rounded style・テーマ色(sky)で shared URL が読める', async () => {
    const geom = await dotGeom('http://localhost:3000')
    const lum = rasterizeDotQr(geom, QR_THEME, 256)
    expect(zxingDecode(lum, 256)).toBe('http://localhost:3000')
  })

  it('rounded style・ finder navy(単色)でも読める', async () => {
    const geom = await dotGeom('http://localhost:3000')
    const lum = rasterizeDotQr(geom, { ...QR_THEME, dotColor: '#0f172a' }, 256)
    expect(zxingDecode(lum, 256)).toBe('http://localhost:3000')
  })

  it('rounded style・ registration token が読める', async () => {
    const token = 'hinotike-registration:0f4e9b4c-5e6f-7a8b-9c0d-1e2f3a4b5c6d'
    const geom = await dotGeom(token)
    const lum = rasterizeDotQr(geom, QR_THEME, 256)
    expect(zxingDecode(lum, 256)).toBe(token)
  })
})
