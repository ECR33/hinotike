import { describe, expect, it } from 'vitest'
import { DEV_ENV_HEADER, mergeDevEnv } from '../../scripts/dev-env-merge.mjs'

/**
 * `.env.development` の合成(scripts/dev-env-merge.mjs)。
 *
 * 実測のバグが対象: `scripts/write-dev-env.mjs` がファイルを**丸ごと**書いていたため、
 * `supabase db reset` → `npm run dev-env` の後に Google の鍵指定
 * (`GOOGLE_SERVICE_ACCOUNT_JSON_PATH`)・シート ID・dev の許可ホストが消え、
 * dev のシート操作が「鍵なし」で落ちていた。キーだけその位置で書き換えて他を保持する。
 */
const updates = {
  NUXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  NUXT_PUBLIC_SUPABASE_KEY: 'sb_publishable_new',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_new',
  SUPABASE_SECRET_KEY: 'sb_secret_new',
}

describe('mergeDevEnv', () => {
  it('Supabase のキーだけ書き換え、Google の設定と dev のホスト設定を残す', () => {
    const existing = [
      '# dev 用の説明',
      NUXT_LINE('NUXT_PUBLIC_SUPABASE_URL', 'http://localhost:54320'),
      NUXT_LINE('NUXT_PUBLIC_SUPABASE_KEY', 'sb_publishable_old'),
      '',
      'DEV_ALLOWED_HOSTS=example.jp',
      'NUXT_PUBLIC_APP_URL=',
      '# Google の鍵はパスで置く',
      'GOOGLE_SERVICE_ACCOUNT_JSON_PATH=./scripts/service-account.json',
      'GOOGLE_SPREADSHEET_ID=1abc',
      NUXT_LINE('SUPABASE_URL', 'http://localhost:54320'),
      NUXT_LINE('SUPABASE_SECRET_KEY', 'sb_secret_old'),
      '',
    ].join('\n')

    const lines = mergeDevEnv(existing, updates)
    const joined = lines.join('\n')

    expect(joined).toContain('GOOGLE_SERVICE_ACCOUNT_JSON_PATH=./scripts/service-account.json')
    expect(joined).toContain('GOOGLE_SPREADSHEET_ID=1abc')
    expect(joined).toContain('DEV_ALLOWED_HOSTS=example.jp')
    expect(joined).toContain('NUXT_PUBLIC_APP_URL=')

    expect(joined).toContain('NUXT_PUBLIC_SUPABASE_URL=http://localhost:54321')
    expect(joined).toContain('NUXT_PUBLIC_SUPABASE_KEY=sb_publishable_new')
    expect(joined).toContain('SUPABASE_SECRET_KEY=sb_secret_new')
    expect(joined).not.toContain('sb_publishable_old')
    expect(joined).not.toContain('sb_secret_old')
    // 更新した行は元の位置に残る(Google の設定より前に Supabase のキーが並ぶ順序を保つ)
    expect(lines.findIndex((l) => l.startsWith('NUXT_PUBLIC_SUPABASE_URL')))
      .toBeLessThan(lines.findIndex((l) => l.startsWith('GOOGLE_SERVICE_ACCOUNT_JSON_PATH')))
    // ヘッダーは1塊だけ(古い説明行の残り防止)
    expect(lines.filter((l) => l.startsWith('#'))).toEqual([
      ...DEV_ENV_HEADER,
      '# Google の鍵はパスで置く',
    ])
  })

  it('ファイルが無いときはキーだけで作る', () => {
    const lines = mergeDevEnv(null, updates)
    expect(lines.slice(0, DEV_ENV_HEADER.length)).toEqual(DEV_ENV_HEADER)
    expect(lines).toContain('SUPABASE_PUBLISHABLE_KEY=sb_publishable_new')
  })

  it('既存に無いキーは末尾に足す(db reset で消えたキーの復活)', () => {
    const lines = mergeDevEnv('NUXT_PUBLIC_SUPABASE_URL=http://localhost:54320\n', updates)
    expect(lines).toContain('SUPABASE_SECRET_KEY=sb_secret_new')
    expect(lines).toContain('SUPABASE_PUBLISHABLE_KEY=sb_publishable_new')
  })

  it('末尾の空行は1つにまとめる(追記で空行が増えない)', () => {
    const joined = mergeDevEnv('NUXT_PUBLIC_SUPABASE_URL=http://localhost:54320\n\n\n', updates).join('\n')
    expect(joined.endsWith('\n')).toBe(true)
    expect(joined.endsWith('\n\n')).toBe(false)
  })
})

function NUXT_LINE(key: string, value: string): string {
  return `${key}=${value}`
}
