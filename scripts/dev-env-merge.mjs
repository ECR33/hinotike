/**
 * `.env.development` の **Supabase キーだけ**を更新する合成ロジック(書き込み側は write-dev-env.mjs)。
 *
 * 既存の行を保持する: このファイルには Supabase のキー以外も置いている
 * (`GOOGLE_SERVICE_ACCOUNT_JSON_PATH` / `GOOGLE_SPREADSHEET_ID` / `DEV_ALLOWED_HOSTS` / `NUXT_PUBLIC_APP_URL`)。
 * 全体を書き換えるとそれらが消え、dev のシート操作が「鍵なし」で落ちる
 * (`server/utils/googleSheets.ts` は dev では `GOOGLE_SERVICE_ACCOUNT_JSON_PATH` から鍵を読む)。
 *
 * 振る舞い:
 * - 既存の先頭コメント塊は新ヘッダーに置き換える(古いキーの説明の残り防止)
 * - `updates` のキーは**その行をその位置で**書き換える(他の行の順序はそのまま)
 * - `updates` のキーが既存に無いときは末尾に追加する
 * - 空行・コメント・未知のキーはそのまま残す
 */
export const DEV_ENV_HEADER = [
  '# ローカル Supabase(supabase start)向けの開発環境ファイル(コミットしない)。',
  '# `supabase db reset` でキーは変わる。再生成: node scripts/write-dev-env.mjs',
]

export function mergeDevEnv(existing, updates) {
  if (existing === null) {
    return [...DEV_ENV_HEADER, ...Object.entries(updates).map(([k, v]) => `${k}=${v}`), '']
  }
  const pending = { ...updates }
  const out = []
  let wroteHeader = false
  for (const line of existing.split('\n')) {
    const t = line.trim()
    if (!wroteHeader && t.startsWith('#')) {
      out.push(...DEV_ENV_HEADER)
      wroteHeader = true
      continue
    }
    const i = t.indexOf('=')
    const key = i > 0 ? t.slice(0, i) : ''
    if (key && key in pending) {
      out.push(`${key}=${pending[key]}`)
      delete pending[key]
      continue
    }
    out.push(line)
  }
  if (!wroteHeader) out.unshift(...DEV_ENV_HEADER)
  // 末尾の空行を捨ててから追記する(空行の後ろにキーを足すと末尾の改行が消える)。
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  for (const [k, v] of Object.entries(pending)) out.push(`${k}=${v}`)
  out.push('')
  return out
}
