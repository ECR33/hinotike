/**
 * Google Spreadsheet → Supabase の同期 CLI(ローカル/手動実行用)。
 *
 * 本体の取り込みは UI(/sync)で行う(Cloudflare Worker 上の API)。この CLI は
 * 開発時のローカル Supabase 反映や、アプリが動いていない場合の手動同期用。
 *
 * 使い方:
 *   1) サービスアカウントキー JSON を scripts/service-account.json に置く(または env でパス指定)
 *   2) スプレッドシートをサービスアカウントの email に共有する
 *   3) 環境ファイルに SUPABASE_URL / SUPABASE_SECRET_KEY を設定
 *   4) 取り込み設定は DB の public.sync_settings(id=1 行)が正。
 *      行が無い/スプレッドシート ID が空のときは既定値 + env の GOOGLE_SPREADSHEET_ID を使う
 *   5) npm run sync:sheets        → .env が指す Supabase(本番)へ同期
 *      npm run sync:sheets:local  → .env.development が指すローカル Supabase へ同期
 *      (--env <file> で任意の環境ファイルを指定可)
 *
 * 選別・rename・code 空スキップは UI と同じ shared/utils/sync.ts を使う(CLI 側は Sheet 読み取りだけ googleapis)。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { google } from 'googleapis'
import { createClient } from '@supabase/supabase-js'
import {
  settingsFromDb,
  sheetTitleFor,
  mapSheetRows,
  chunk,
  UPSERT_BATCH,
  MAX_SYNC_ROWS,
} from '../shared/utils/sync.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function envFileFromArgs(): string {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env') return args[i + 1] ?? '.env'
    if (args[i].startsWith('--env=')) return args[i].slice('--env='.length)
  }
  return '.env'
}

function loadEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (!fs.existsSync(file)) return env
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i > 0) env[t.slice(0, i)] = t.slice(i + 1)
  }
  return env
}

/** CLI 側の全 code 取得(API の allCodes と同じ range ページング)。 */
async function allTableCodes(supabase: ReturnType<typeof createClient>, table: string): Promise<Set<string>> {
  const found = new Set<string>()
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select('code').range(from, from + PAGE - 1)
    if (error) throw new Error(`全 code 照会失敗 (${table}): ${error.message}`)
    const rows = data ?? []
    for (const r of rows) if (typeof r.code === 'string') found.add(r.code)
    if (rows.length < PAGE) break
  }
  return found
}

async function main() {
  const envFile = envFileFromArgs()
  const env = { ...loadEnv(path.join(ROOT, envFile)), ...process.env }

  const SUPABASE_URL = env.SUPABASE_URL ?? env.NUXT_PUBLIC_SUPABASE_URL
  const SUPABASE_KEY = env.SUPABASE_SECRET_KEY ?? env.NUXT_SUPABASE_SECRET_KEY
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error(`SUPABASE_URL / SUPABASE_SECRET_KEY が ${envFile} にありません`)
    process.exit(1)
  }

  // 鍵は「パス」または「JSON 文字列」のどちらでも受け付ける。
  // Worker/本番の secret は JSON 文字列(GOOGLE_SERVICE_ACCOUNT_JSON)、ローカル CLI はパス指定を推奨。
  const saRaw = env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH ?? env.GOOGLE_SERVICE_ACCOUNT_JSON ?? ''
  const isJson = saRaw.trim().startsWith('{')
  let auth: google.auth.GoogleAuth
  if (isJson) {
    auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(saRaw),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    })
  } else {
    const saPath = path.resolve(ROOT, saRaw || './scripts/service-account.json')
    if (!fs.existsSync(saPath)) {
      console.error(`サービスアカウントキーが見つかりません: ${saPath}`)
      process.exit(1)
    }
    auth = new google.auth.GoogleAuth({
      keyFile: saPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    })
  }
  const sheets = google.sheets({ version: 'v4', auth })

  // 設定は DB 行が正(Secret key は RLS を bypass するので CLI から読める)。
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  const { data: row, error: rowError } = await supabase
    .from('sync_settings')
    .select('spreadsheet_id, worksheet, code_column, include_columns, exclude_columns, filter_column, filter_values, prune_on_commit, rename, target_table')
    .eq('id', 1)
    .maybeSingle()
  if (rowError) {
    console.warn(`sync_settings の読み込み失敗(既定値を使用): ${rowError.message}`)
  }
  const settings = settingsFromDb(row as Record<string, unknown> | null)

  // 設定行のスプレッドシート ID が空なら env の値で補う(UI で設定する前の運用)。
  const spreadsheetId = settings.spreadsheetId || env.GOOGLE_SPREADSHEET_ID || ''
  if (!spreadsheetId) {
    console.error(`スプレッドシート ID がありません(sync_settings の行または ${envFile} の GOOGLE_SPREADSHEET_ID を設定してください)`)
    process.exit(1)
  }

  console.log(`同期先: ${SUPABASE_URL} / テーブル ${settings.targetTable} / シート ID: ${spreadsheetId} (環境ファイル: ${envFile})`)

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId })
  const titles = (spreadsheet.data.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => Boolean(t))
  const title = sheetTitleFor(titles, settings.worksheet)
  if (!title) {
    console.error('ワークシートが見つかりません')
    process.exit(1)
  }
  if (settings.worksheet && settings.worksheet !== title) {
    console.warn(`設定のワークシート名 "${settings.worksheet}" が見つからないため "${title}" を使用しました`)
  }

  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: title })
  const values = data.values ?? []
  if (values.length < 2) {
    console.error('データ行がありません(ヘッダー + 1行以上必要)')
    process.exit(1)
  }
  const dataRows = values.length - 1
  if (dataRows > MAX_SYNC_ROWS) {
    console.error(`シートが上限(${MAX_SYNC_ROWS}行)を超えています(${dataRows}行)。部分書き込みはしません`)
    process.exit(1)
  }

  const mapped = mapSheetRows(values, settings)
  console.log(`シート "${title}": ヘッダー ${mapped.headers.length}カラム / データ ${dataRows}行`)
  console.log(`ヘッダー: ${mapped.headers.join(', ')}`)
  if (mapped.codeColumnMissing) {
    console.error(`code カラム "${settings.codeColumn}" がヘッダーにありません。sync_settings の code_column を修正してください`)
    process.exit(1)
  }
  if (mapped.filterColumnMissing) {
    console.error(`行フィルタのカラム "${settings.filterColumn}" がヘッダーにありません。sync_settings の filter_column を修正してください`)
    process.exit(1)
  }
  console.log(`取り込み対象カラム: ${mapped.columns.join(', ')}`)
  if (settings.filterColumn) {
    const allowed = settings.filterValues.length > 0 ? settings.filterValues.join(', ') : '(値が非空なら有効)'
    console.log(`行フィルタ: "${settings.filterColumn}" の値が有効 (${allowed})`)
  }
  console.log(`upsert: ${mapped.rows.length}件(code 空スキップ ${mapped.skipped}件 / 行フィルタ除外 ${mapped.filtered}件)`)

  // 既存 code を照会して内訳を報告する(upsert の挙動は idempotent)。
  const codes = mapped.rows.map((r) => r.code)
  const existing = new Set<string>()
  for (const part of chunk(codes, 100)) {
    const { data: found, error } = await supabase.from(settings.targetTable).select('code').in('code', part)
    if (error) {
      console.error(`既存 code の照会失敗: ${error.message}`)
      process.exit(1)
    }
    for (const r of found ?? []) if (typeof r.code === 'string') existing.add(r.code)
  }
  const updateCount = codes.filter((c) => existing.has(c)).length
  console.log(`  新規 ${codes.length - updateCount}件 / 既存更新 ${updateCount}件`)

  const importedAt = new Date().toISOString()
  for (const part of chunk(mapped.rows, UPSERT_BATCH)) {
    const { error } = await supabase
      .from(settings.targetTable)
      .upsert(part.map((r) => ({ code: r.code, payload: r.payload, imported_at: importedAt })), { onConflict: 'code' })
    if (error) {
      console.error(`upsert 失敗: ${error.message}`)
      process.exit(1)
    }
  }

  // prune(API と同じガード: ワークシート不一致・取り込み 0 行では削除しない)。
  if (settings.pruneOnCommit) {
    if (settings.worksheet && settings.worksheet !== title) {
      console.warn(`prune 中止: 設定のワークシート "${settings.worksheet}" ≠ 実際のシート "${title}"`)
    } else if (mapped.rows.length === 0) {
      console.warn('prune 中止: 取り込み対象が 0 行(全行フィルタ除外または空シート)')
    } else {
      const sheetCodes = new Set(codes)
      const stale = [...(await allTableCodes(supabase, settings.targetTable))].filter((c) => !sheetCodes.has(c))
      let deleted = 0
      for (const part of chunk(stale, 100)) {
        const { data: gone, error } = await supabase.from(settings.targetTable).delete().in('code', part).select('code')
        if (error) {
          console.error(`delete 失敗: ${error.message}`)
          process.exit(1)
        }
        deleted += (gone ?? []).length
      }
      console.log(`prune: ${deleted}件を削除しました(シートに無い code)`)
    }
  }

  console.log(`完了: ${settings.targetTable} テーブルに ${mapped.rows.length}件を upsert しました`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
