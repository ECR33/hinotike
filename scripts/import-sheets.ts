/**
 * Google スプレッドシート → 取り込み行の**プレビュー / ダンプ** CLI(ローカル・手動実行用)。
 *
 * 本体の取り込みは UI(/scan の「このデータを端末に取り込む」→ GET /api/import)で行う。
 * この CLI は Worker を起動せずに取り込み結果を確認・デバッグするためのもの。
 * **Supabase にデータは書かない**(シートが唯一の正で、行は端末の IndexedDB に保存する)。
 *
 * 使い方:
 *   1) サービスアカウントキー JSON を scripts/service-account.json に置く(または env でパス指定)
 *   2) 各スプレッドシートをサービスアカウントの email に共有する
 *   3) 環境ファイルに SUPABASE_URL / SUPABASE_SECRET_KEY を設定(定義の読み取り用)
 *   4) 取り込み定義は DB の public.sync_sources(複数行)が正
 *      行が無いときは既定(shared/utils/sync.ts の DEFAULT_SOURCE)+ env の GOOGLE_SPREADSHEET_ID を使う
 *   5) npm run sheets:preview            → .env が指す Supabase の定義を全部プレビュー
 *      npm run sheets:preview:local      → .env.development(ローカル Supabase)の定義をプレビュー
 *      npm run sheets:dump -- --source 1 --out /tmp/dataset.json  → 1データセットの行を JSON に書く
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
  DEFAULT_SOURCE,
  MAX_IMPORT_ROWS,
  mapSheetRows,
  payloadKeysOf,
  sheetTitleFor,
  sourceFromDb,
  spreadsheetIdFrom,
  type SyncSource,
} from '../shared/utils/sync.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function argValue(name: string): string | null {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1] ?? null
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1)
  }
  return null
}

function envFileFromArgs(): string {
  return argValue('--env') ?? '.env'
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

async function main() {
  const envFile = envFileFromArgs()
  const env = { ...loadEnv(path.join(ROOT, envFile)), ...process.env }

  const SUPABASE_URL = env.SUPABASE_URL ?? env.NUXT_PUBLIC_SUPABASE_URL
  const SUPABASE_KEY = env.SUPABASE_SECRET_KEY ?? env.NUXT_SUPABASE_SECRET_KEY
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error(`SUPABASE_URL / SUPABASE_SECRET_KEY が ${envFile} にありません`)
    process.exit(1)
  }

  // 鍵は「パス」または「JSON 文字列」のどちらでも受け付ける(Worker の secret は JSON 文字列)。
  const saRaw = env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH ?? env.GOOGLE_SERVICE_ACCOUNT_JSON ?? ''
  const isJson = saRaw.trim().startsWith('{')
  let auth: google.auth.GoogleAuth
  if (isJson) {
    auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(saRaw),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })
  } else {
    const saPath = path.resolve(ROOT, saRaw || './scripts/service-account.json')
    if (!fs.existsSync(saPath)) {
      console.error(`サービスアカウントキーが見つかりません: ${saPath}`)
      process.exit(1)
    }
    auth = new google.auth.GoogleAuth({
      keyFile: saPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })
  }
  const sheets = google.sheets({ version: 'v4', auth })

  // 定義は DB 行が正(Secret key は RLS を bypassするので CLI から読める)。複数データセット。
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  const { data: rows, error: rowsError } = await supabase
    .from('sync_sources')
    .select('id, name, spreadsheet_id, worksheet, code_column, include_columns, exclude_columns, filter_column, filter_values, rename, enabled, updated_at, updated_by')
    .order('id', { ascending: true })
  if (rowsError) console.warn(`sync_sources の読み込み失敗(既定値を使用): ${rowsError.message}`)

  let sources: SyncSource[] = (rows ?? [])
    .map((row) => sourceFromDb(row as Record<string, unknown>))
    .filter((s): s is SyncSource => s !== null)
  if (sources.length === 0) {
    // env の指定は ID でもシートのリンクでも同じように読める(人間はリンクを貼る)
    sources = [{ ...DEFAULT_SOURCE, spreadsheetId: spreadsheetIdFrom(env.GOOGLE_SPREADSHEET_ID ?? '') }]
    console.warn(`sync_sources の行がありません(既定の1データセットで試します)`)
  }

  const onlySource = argValue('--source')
  if (onlySource !== null) {
    const id = Number(onlySource)
    sources = sources.filter((s) => s.id === id)
    if (sources.length === 0) {
      console.error(`データセット id ${onlySource} が見つかりません(${SUPABASE_URL} の sync_sources)`)
      process.exit(1)
    }
  }
  const dumpOut = argValue('--out')

  console.log(`定義の読み取り先: ${SUPABASE_URL} (環境ファイル: ${envFile}) / データセット ${sources.length}個`)

  for (const source of sources) {
    console.log(`\n── データセット ${source.id ?? '-'} "${source.name}"${source.enabled ? '' : ' (無効)'} ──`)
    if (!source.spreadsheetId) {
      console.log('  スプレッドシート ID が未設定(取り込み不可)。/sync でシートのリンクを貼るか、sync_sources の spreadsheet_id を設定してください')
      continue
    }

    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: source.spreadsheetId })
    const titles = (spreadsheet.data.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => Boolean(t))
    const title = sheetTitleFor(titles, source.worksheet)
    if (!title) {
      console.error(`  ワークシートが見つかりません(シート一覧: ${titles.join(', ') || 'なし'})`)
      continue
    }
    if (source.worksheet && source.worksheet !== title) {
      console.warn(`  設定のワークシート名 "${source.worksheet}" が見つからないため "${title}" を使用しました`)
    }

    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: source.spreadsheetId, range: title })
    const values = data.values ?? []
    if (values.length < 2) {
      console.error('  データ行がありません(ヘッダー + 1行以上必要)')
      continue
    }
    const dataRows = values.length - 1
    const truncated = dataRows > MAX_IMPORT_ROWS
    const mapped = mapSheetRows(truncated ? values.slice(0, MAX_IMPORT_ROWS + 1) : values, source)

    console.log(`  シート "${title}": ヘッダー ${mapped.headers.length}カラム / データ ${dataRows}行${truncated ? `(${MAX_IMPORT_ROWS}行で打ち切り)` : ''}`)
    console.log(`  ヘッダー: ${mapped.headers.join(', ')}`)
    if (mapped.codeColumnMissing) {
      console.error(`  code カラム "${source.codeColumn}" がヘッダーにありません。sync_sources の code_column を修正してください`)
      continue
    }
    if (mapped.filterColumnMissing) {
      console.error(`  行フィルタのカラム "${source.filterColumn}" がヘッダーにありません。sync_sources の filter_column を修正してください`)
      continue
    }
    console.log(`  取り込み対象カラム: ${mapped.columns.join(', ')}`)
    if (source.filterColumn) {
      const allowed = source.filterValues.length > 0 ? source.filterValues.join(', ') : '(値が非空なら有効)'
      console.log(`  行フィルタ: "${source.filterColumn}" の値が有効 (${allowed})`)
    }
    console.log(`  取り込み行: ${mapped.rows.length}件(code 空スキップ ${mapped.skipped}件 / 行フィルタ除外 ${mapped.filtered}件)`)
    console.log(`  payload キー: ${payloadKeysOf(mapped.rows).join(', ')}`)
    console.log(`  先頭サンプル: ${JSON.stringify(mapped.rows.slice(0, 3))}`)

    if (dumpOut) {
      fs.writeFileSync(
        dumpOut,
        JSON.stringify({ source, sheetTitle: title, importedAt: new Date().toISOString(), rows: mapped.rows }, null, 2),
      )
      console.log(`  ダンプ: ${dumpOut}`)
    }
  }

  console.log('\n完了(データは端末に保存します。この CLI は Supabase に書き込みません)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
