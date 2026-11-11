import { describe, it, expect } from 'vitest'
import {
  QRCodeWriter,
  BarcodeFormat,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
  QRCodeReader,
  DecodeHintType,
  type BitMatrix,
} from '@zxing/library'
import { libraryScanRegion, CROP_FRAC, SMALL_CROP_FRAC } from '../../shared/utils/qr-scan'

// 標準UI(qr-scanner の連続スキャン)が照合する領域の検証。
// 実際のデコードはライブラリのエンジン(native BarcodeDetector / jsQR worker)が行うが、
// ここでは「ライブラリが canvas へ描く領域」を同じ条件(nearest 拡大)で再現し、
// zxing の QRCodeReader(TRY_HARDER)で読んで、領域が中央のQRだけを含み
// 隣のQRを含まないことを確認する。
const W = 640
const H = 480

const reader = new QRCodeReader(new Map([[DecodeHintType.TRY_HARDER, true]]))

function encode(text: string, size: number): BitMatrix {
  // この library では encode の hints が必須(Map でも OK)。renderResult が quiet zone を内部に含む。
  return new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, new Map())
}

/** 白背景の輝度配列(W*H, 1byte/pixel)にQRを塗る。 */
function paint(lum: Uint8Array, text: string, size: number, cx: number, cy: number): void {
  const m = encode(text, size)
  for (let y = 0; y < m.getHeight(); y++) {
    for (let x = 0; x < m.getWidth(); x++) {
      if (m.get(x, y)) lum[(cy + y) * W + cx + x] = 0
    }
  }
}

function blankLum(): Uint8Array {
  return new Uint8Array(W * H).fill(255)
}

/**
 * ライブラリの描画(_drawToCanvas)と同じ経路: 領域(x,y,width,height)を
 * nearest で downScaled に拡大し、その全体をデコードする。
 * 領域外のピクセルは参照しない(=隣のQRは読まない)。
 */
function decodeRegion(lum: Uint8Array, r: ReturnType<typeof libraryScanRegion>): string | null {
  const zoom = r.downScaledWidth / r.width
  const zoomed = new Uint8Array(r.downScaledWidth * r.downScaledHeight)
  for (let y = 0; y < r.downScaledHeight; y++) {
    for (let x = 0; x < r.downScaledWidth; x++) {
      zoomed[y * r.downScaledWidth + x] = lum[(r.y + Math.floor(y / zoom)) * W + r.x + Math.floor(x / zoom)]
    }
  }
  try {
    return reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(zoomed, r.downScaledWidth, r.downScaledHeight)))).getText()
  } catch {
    return null
  }
}

describe('libraryScanRegion (qr-scanner標準UIの照合領域)', () => {
  it('大モード: 短辺(480)の50%の中央正方形, 縮小なし', () => {
    expect(libraryScanRegion(W, H, CROP_FRAC)).toEqual({
      x: 200,
      y: 120,
      width: 240,
      height: 240,
      downScaledWidth: 240,
      downScaledHeight: 240,
    })
  })

  it('小モード: 短辺の25%の中央正方形を3倍に拡大(downScaled)', () => {
    const r = libraryScanRegion(W, H, SMALL_CROP_FRAC, 3)
    expect(r).toEqual({ x: 260, y: 180, width: 120, height: 120, downScaledWidth: 360, downScaledHeight: 360 })
  })

  it('領域と縮小後のアスペクト比が一致する(ライブラリの要件)', () => {
    const r = libraryScanRegion(W, H, SMALL_CROP_FRAC, 2)
    expect(r.width / r.height).toBeCloseTo(r.downScaledWidth / r.downScaledHeight, 6)
  })

  it('映像サイズ未確定では安全な値を返す(0x0/短辺0)', () => {
    expect(libraryScanRegion(0, 0, CROP_FRAC)).toEqual({ x: 0, y: 0, width: 0, height: 0, downScaledWidth: 0, downScaledHeight: 0 })
    // 短辺が枠未満(side=0)の映像はフレーム全体にフォールバック
    expect(libraryScanRegion(100, 0.4, CROP_FRAC)).toEqual({ x: 0, y: 0, width: 100, height: 0.4, downScaledWidth: 100, downScaledHeight: 0.4 })
  })

  it('枠の選択は 50%(大)と 25%(小・大枠の1/2)', () => {
    expect(CROP_FRAC).toBe(0.5)
    expect(SMALL_CROP_FRAC).toBe(0.25)
  })

  it('大モードの領域は中央のQRだけを読む(隣のQRは読まない)', () => {
    const lum = blankLum()
    const r = libraryScanRegion(W, H, CROP_FRAC)
    paint(lum, 'CENTER-CODE', 200, Math.floor((W - 200) / 2), Math.floor((H - 200) / 2)) // 領域内
    paint(lum, 'NOPE-LEFT', 100, 0, Math.floor((H - 100) / 2)) // 領域の真外(x < r.x)
    paint(lum, 'NOPE-RIGHT', 100, W - 100, Math.floor((H - 100) / 2)) // 領域の真外(x >= r.x+r.width)
    expect(decodeRegion(lum, r)).toBe('CENTER-CODE')
  })

  it('領域外のQRだけなら読めない', () => {
    const r = libraryScanRegion(W, H, CROP_FRAC)
    const lum = blankLum()
    paint(lum, 'NOPE-LEFT', 100, 0, Math.floor((H - 100) / 2))
    expect(decodeRegion(lum, r)).toBeNull()
    const lum2 = blankLum()
    paint(lum2, 'NOPE-RIGHT', 100, W - 100, Math.floor((H - 100) / 2))
    expect(decodeRegion(lum2, r)).toBeNull()
  })

  it('QRなし・ノイズフレームは null(デコード例外が上位に伝わらない)', () => {
    const r = libraryScanRegion(W, H, CROP_FRAC)
    expect(decodeRegion(blankLum(), r)).toBeNull()
    const noise = new Uint8Array(W * H)
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 37) % 256
    expect(decodeRegion(noise, r)).toBeNull()
  })

  it('小モード(nearest 3倍拡大)では小さいQRが読め、領域外の大きいQRは読まない', () => {
    const r = libraryScanRegion(W, H, SMALL_CROP_FRAC, 3)
    const lum = blankLum()
    const small = 46
    paint(lum, 'SMALL-CODE', small, Math.floor((W - small) / 2), Math.floor((H - small) / 2)) // 領域内
    paint(lum, 'BIG-DECOY', 100, 0, Math.floor((H - 100) / 2))
    paint(lum, 'BIG-DECOY2', 100, W - 100, Math.floor((H - 100) / 2))
    expect(decodeRegion(lum, r)).toBe('SMALL-CODE')
  })
})
