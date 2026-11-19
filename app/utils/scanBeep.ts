/**
 * 読み取り音(「ピッ」)の合成(Web Audio)。client からのみ使う。
 *
 * - 音声ファイルは使わない: 読み取り音はオフラインモード(地下など通信が無い場所)でも鳴る必要が
 *   あるため、ネットワークもアセットも要らない oscillator の合成にする。
 * - ブラウザの autoplay policy で AudioContext はユーザー操作がないと suspended のままになる。
 *   /scan は画面に着いた時点で自動でスキャンを開始するので(ジェスチャー無し)、最初のタップ
 *   (モード選択・枠内トグル・画面自体)で resume Try を走らせる。それ以前の検出は黙って鳴らない。
 * - 「ピッ」は短い単音: 2.2kHz の sine を 12ms で立ち上げ 120ms で減衰。長音・連音は
 *   「読み取り完了」の合図としては煩所以、1読み取り=1音だけ。
 */

/** 静音状態の storage key(この端末の選び方をリロード後も引き継ぐ)。 */
export const BEEP_MUTE_STORAGE_KEY = 'hinotike-scan-beep-muted'

let ctx: AudioContext | null = null

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  if (!ctx) {
    try {
      ctx = new AC()
    } catch {
      return null
    }
  }
  return ctx
}

/**
 * 初期化 + 音声の解放を試みる。ユーザー操作の途中(タップ・キー)から呼ぶと resume が効く。
 * AudioContext を作るのはこの関数なので、スキャン開始(自動)だけで呼ぶと suspended のまま
 * (鳴らない)だが、エラーにはしない。
 */
export function unlockScanBeep(): void {
  const c = audioContext()
  if (!c) return
  if (c.state === 'suspended') void c.resume().catch(() => {})
}

/** 「ピッ」。suspended(まだジェスチャーが無い)なら resume を試して今回は鳴らない。 */
export function playScanBeep(): void {
  const c = audioContext()
  if (!c) return
  if (c.state !== 'running') {
    void c.resume().catch(() => {})
    return
  }
  const now = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  // 2.2kHz 程度: 現場(騒ぐ会場・人の声の中)で聞き分けられる高さ。低い音は雑音に埋もれる。
  osc.frequency.setValueAtTime(2200, now)
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.22, now + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12)
  osc.connect(gain)
  gain.connect(c.destination)
  osc.start(now)
  osc.stop(now + 0.14)
}

/** localStorage の静音フラグを読む。非 client・破損は「鳴る」(既定 ON)。 */
export function readBeepMutedFromStorage(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(BEEP_MUTE_STORAGE_KEY) === '1'
}

export function writeBeepMutedToStorage(muted: boolean): void {
  if (typeof localStorage === 'undefined') return
  if (muted) localStorage.setItem(BEEP_MUTE_STORAGE_KEY, '1')
  else localStorage.removeItem(BEEP_MUTE_STORAGE_KEY)
}
