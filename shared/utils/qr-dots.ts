/**
 * ドットスタイル QR の幾何生成(qrcode-vue3 の dot style の参考実装を踏襲)。
 *
 * qrcode ライブラリの QRCode.create(text, {errorCorrectionLevel}) が返す
 * BitMatrix(modules) を、SVG で「ドット+リング型 finder」に描き直すための
 * 幾何データに変換する。描画色はアプリテーマ(ドット=sky, finder=navy, 背景=白)。
 *
 * finder の描き方は2スタイル:
 *  - rounded(既定): 外リング(stroke1・角丸)+ 内部3x3の塗りつぶし。
 *    走査線の明暗比率 1:1:3:1:1 が经典 QR と一致するため、jsQR/zxing/native
 *    のどのリーダーでも読める(実測で zxing デコード OK)。
 *  - ring: 外リング(stroke0.7)+ 内部9ドット。見た目は画像に近いが走査線の
 *    比率が崩れ jsQR/zxing では読めない(Node 実測 NotFoundException)。
 *    外部カメラ専用用途向けに残している(アプリ内スキャンでは使わない)。
 *
 * finder 領域(7x7 block)のドットは描画対象から除外する。行/列 index 8 の
 * format info は除外しない(8x8 排除だと format info を殺して checksum 失敗)。
 */

export type FinderStyle = 'ring' | 'rounded'

export interface DotQrTheme {
  dotColor: string
  finderColor: string
  background: string
}

export const QR_THEME: DotQrTheme = {
  dotColor: '#38bdf8',
  finderColor: '#0f172a',
  background: '#ffffff',
}

// 1 module 単位系でのドット半径(直径 0.68 module)。
const DOT_R = 0.34
// quiet zone(margin)。QR 仕様では 4 module 推奨だが表示上 2 で許容される
// (スキャン側も周囲の白を拾えるため jsQR/zxing 実測で読める)。
const DEFAULT_MARGIN = 2

export interface DotQrDot {
  cx: number
  cy: number
  r: number
}

export interface DotQrFinder {
  cx: number
  cy: number
  /** rounded: 角丸リング outline の半径(ringR) */
  ringR: number
  /** リングの stroke 幅 */
  stroke: number
  /** rounded: 内部の塗りつぶし正方形の半辺 */
  innerHalf: number
  /** rounded: 内部正方形の角丸半径 */
  innerRx: number
  /** ring: 内部 9 ドット(3x3)の中心集合 */
  innerDots: Array<{ cx: number; cy: number }>
}

export interface DotQrGeometry {
  /** QR の module 数(modules.size) */
  size: number
  /** SVG の viewBox 辺(size + 2*margin) */
  dim: number
  margin: number
  dots: DotQrDot[]
  finders: DotQrFinder[]
}

/** 3つの finder block(7x7): 左上/右上/左下。データドット除外用。 */
function isFinderZone(x: number, y: number, size: number): boolean {
  const topRow = y <= 6
  const bottomRow = y >= size - 7
  const leftCol = x <= 6
  const rightCol = x >= size - 7
  return (topRow && leftCol) || (topRow && rightCol) || (bottomRow && leftCol)
}

interface BitMatrixLike {
  size: number
  get: (x: number, y: number) => boolean
}

export function buildDotQrGeometry(
  qr: { modules: BitMatrixLike },
  opts: { margin?: number; finderStyle?: FinderStyle } = {},
): DotQrGeometry {
  const margin = opts.margin ?? DEFAULT_MARGIN
  const style = opts.finderStyle ?? 'rounded'
  const size = qr.modules.size
  const dim = size + margin * 2

  const dots: DotQrDot[] = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFinderZone(x, y, size)) continue
      if (!qr.modules.get(x, y)) continue
      dots.push({ cx: x + margin + 0.5, cy: y + margin + 0.5, r: DOT_R })
    }
  }

  // finder 中心(7x7 block の中心)。module 座標 + margin。
  const centers = [
    { cx: 3.5 + margin, cy: 3.5 + margin },
    { cx: size - 3.5 + margin, cy: 3.5 + margin },
    { cx: 3.5 + margin, cy: size - 3.5 + margin },
  ]
  const finders: DotQrFinder[] = centers.map(({ cx, cy }) =>
    style === 'ring'
      ? {
          cx,
          cy,
          ringR: 2.05,
          stroke: 0.7,
          innerHalf: 0,
          innerRx: 0,
          innerDots: [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => ({ cx: cx + dx, cy: cy + dy }))),
        }
      : {
          cx,
          cy,
          // 外縁 half 3.5(stroke1 の rect center cx-3..cx+3)で classic の
          // 走査線比率 1:1:3:1:1 を保つ(half 3 だと比率が崩れ NotFoundException)。
          ringR: 3.5,
          stroke: 1,
          innerHalf: 1.5,
          innerRx: 0.8,
          innerDots: [],
        },
  )

  return { size, dim, margin, dots, finders }
}
