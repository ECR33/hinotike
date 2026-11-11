/**
 * スキャン照合領域のロジック(qr-scanner 標準UIと単体テストの共通実装)。
 * 画像の中央正方形(一辺 = 短辺 * frac)だけを見てQRを1件読む。
 * 中央領域の外(隣のQRコードなど)は読まない。
 */
export const CROP_FRAC = 0.5
export const SMALL_CROP_FRAC = 0.25

/**
 * qr-scanner(nimiq)の QrScanner(連続スキャン)の calculateScanRegion 用。
 * ライブラリ既定値は「短辺2/3の中央正方形 → 400x400へ縮小」。ここでは枠の選択
 * (50% / 25%)と小モードのデジタルズームを反映する。
 * ライブラリは canvas 描画時に imageSmoothingEnabled=false(nearest)なので、
 * downScaled を領域より大きくすると nearest 拡大=デジタルズームになる
 * (小モード: 領域を3倍拡大 → 小さいQRでもモジュールが数pxになり読める)。
 * width/height と downScaledWidth/downScaledHeight のアスペクト比は同一(正方形)にする。
 */
export function libraryScanRegion(
  videoWidth: number,
  videoHeight: number,
  frac: number,
  zoom = 1,
): {
  x: number
  y: number
  width: number
  height: number
  downScaledWidth: number
  downScaledHeight: number
} {
  if (videoWidth <= 0 || videoHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0, downScaledWidth: 0, downScaledHeight: 0 }
  }
  const side = Math.round(Math.min(videoWidth, videoHeight) * frac)
  if (side <= 0) {
    // metadata 未確定のフレームではフレーム全体(ライブラリ既定動作)にフォールバック
    return {
      x: 0,
      y: 0,
      width: videoWidth,
      height: videoHeight,
      downScaledWidth: videoWidth,
      downScaledHeight: videoHeight,
    }
  }
  const down = Math.max(1, Math.round(side * zoom))
  return {
    x: Math.round((videoWidth - side) / 2),
    y: Math.round((videoHeight - side) / 2),
    width: side,
    height: side,
    downScaledWidth: down,
    downScaledHeight: down,
  }
}
