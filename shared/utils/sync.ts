/**
 * Google Spreadsheet → スマホ内(IndexedDB)の取り込み定義(純粋関数)。
 *
 * 設計(2026-11-22 の複数データセット化):
 * - 取り込み**定義**は DB(public.sync_sources)の**複数行**が正。1行 = 1データセット
 *   (スプレッドシート + ワークシート + code カラム + 取り込みカラムの選別)。管理 UI(/sync)から編集する。
 * - データ本体は Supabase に置かない。取り込みは `GET /api/import`(Worker がサービスアカウント鍵で
 *   シートを読み、`mapSheetRows` した行を chunk で返す)→ 画面が IndexedDB に保存する。
 *   シートが唯一の正(source of truth)で、書き戻しは `/api/scan-flush` / `/api/remark-update` が
 *   シートへ直接書く(旧 `items` テーブルへの payload 反映は廃止)。
 * - 選別・rename・code 空スキップはここが唯一の実装。API(server/api/*)と画面のローカル照合
 *   (shared/utils/offline.ts)が同じ関数・同じ意味で動く。
 * Nuxt 依存の import は置かない(server / shared / CLI どちらでも読めるように)。
 */

/** 1データセットの取り込み定義(public.sync_sources の 1行)。 */
export interface SyncSource {
  /** DB の serial id。未作成(新規ドラフト)は null */
  id: number | null
  /** 画面の選択に出す表示名(DB は name UNIQUE。重複は normalize で除く) */
  name: string
  /** Google スプレッドシート ID(未設定なら取り込みできない) */
  spreadsheetId: string
  /** 対象ワークシート名。null/空なら最初シート */
  worksheet: string | null
  /** QR 照会キーになるヘッダー名(1つ必須) */
  codeColumn: string
  /** 空 = 全カラム。非空 = この許容リストのみ取り込み(codeColumn は常に保持) */
  includeColumns: string[]
  /** includeColumns が空のときに除外するカラム名 */
  excludeColumns: string[]
  /**
   * 行の有効/無効を表すカラム名。null/空 = 行フィルタなし(全行が取り込み対象)。
   * 指定すると、このカラムの値が filterValues に合う行のみ取り込む(値の比較は trim 後の完全一致)。
   */
  filterColumn: string | null
  /** filterColumn の許容値(複数可)。空リスト = そのカラムの値が非空なら有効 */
  filterValues: string[]
  /** payload のキー名を書き換える: { "元カラム名": "新キー名" } */
  rename: Record<string, string>
  /** false = 画面のソース選択に出さない(削除せずに運用を止める) */
  enabled: boolean
  updatedAt: string | null
  updatedBy: string | null
}

/** migrations/0007_data_sources.sql のシード行と同じ値(片方を変えたらもう片方も直す)。 */
export const DEFAULT_SOURCE: SyncSource = {
  id: null,
  name: '既定のシート',
  spreadsheetId: '',
  worksheet: 'フォームの回答 1',
  codeColumn: 'ID',
  includeColumns: [
    '学年',
    'クラス',
    '氏名',
    '支払い方法',
    '領収書が必要な方はチェックをお願いします。',
    '購入金額',
    '入金状況',
    '入金額',
    'ひのドッグ(個数)',
    'やきそば(個数)',
    '麦茶(個数)',
    'サイダー(個数)',
    'カルピス(個数)',
    'りんご(個数)',
    'ゲーム(個数)',
    '備考',
  ],
  excludeColumns: [],
  filterColumn: null,
  filterValues: [],
  rename: { '領収書が必要な方はチェックをお願いします。': '領収書' },
  enabled: true,
  updatedAt: null,
  updatedBy: null,
}

/** スプレッドシート ID: 英数字・ハイフン・アンダースコア(Google が発行する形)。 */
export function isSafeSpreadsheetId(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{10,120}$/.test(name)
}

/** データセットの表示名(チップと UNIQUE キー用)。 */
export const SOURCE_NAME_MAX_LENGTH = 40

export function isSafeSourceName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= SOURCE_NAME_MAX_LENGTH
}

/**
 * UI/API から来た生データを正規化する。不正な値は DEFAULT にフォールバックする
 * (throw すると保存画面が固まるため、項目単位で補正する)。
 * spreadsheetId は空文字を許す(未設定 = 取り込み不可。API 側で 400 にする)。
 */
export function normalizeSource(raw: Partial<SyncSource> | null | undefined): SyncSource {
  const base = DEFAULT_SOURCE
  const spreadsheetId =
    typeof raw?.spreadsheetId === 'string' ? raw.spreadsheetId.trim() : ''
  const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, SOURCE_NAME_MAX_LENGTH) : ''
  return {
    id: typeof raw?.id === 'number' && Number.isInteger(raw.id) ? raw.id : null,
    name: name || '名称未設定',
    spreadsheetId: isSafeSpreadsheetId(spreadsheetId) ? spreadsheetId : '',
    worksheet:
      typeof raw?.worksheet === 'string' && raw.worksheet.trim()
        ? raw.worksheet.trim()
        : null,
    codeColumn:
      typeof raw?.codeColumn === 'string' && raw.codeColumn.trim()
        ? raw.codeColumn.trim()
        : base.codeColumn,
    includeColumns: Array.isArray(raw?.includeColumns)
      ? raw!.includeColumns!.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
      : [],
    excludeColumns: Array.isArray(raw?.excludeColumns)
      ? raw!.excludeColumns!.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
      : [],
    filterColumn:
      typeof raw?.filterColumn === 'string' && raw.filterColumn.trim()
        ? raw.filterColumn.trim()
        : null,
    filterValues: Array.isArray(raw?.filterValues)
      ? raw!.filterValues!.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
      : [],
    rename:
      raw?.rename && typeof raw.rename === 'object' && !Array.isArray(raw.rename)
        ? Object.fromEntries(
            Object.entries(raw.rename).filter(
              ([from, to]) => typeof from === 'string' && from.trim() && typeof to === 'string' && to.trim(),
            ).map(([from, to]) => [from.trim(), (to as string).trim()]),
          )
        : {},
    enabled: raw?.enabled !== false,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    updatedBy: typeof raw?.updatedBy === 'string' ? raw.updatedBy : null,
  }
}

/** 複数ソースのリストを正規化する(名前重複は最初の1つだけ残す。DB の UNIQUE と同じ契約)。 */
export function normalizeSources(raw: unknown): SyncSource[] {
  const items = Array.isArray(raw) ? raw : []
  const seen = new Set<string>()
  const out: SyncSource[] = []
  for (const item of items) {
    const source = normalizeSource(item as Partial<SyncSource>)
    if (seen.has(source.name)) continue
    seen.add(source.name)
    out.push(source)
    if (out.length >= SOURCE_MAX) break
  }
  return out
}

/** 保持できるデータセット数の上限(設定画面の膨張と、シート読み取りの連打を防ぐ)。 */
export const SOURCE_MAX = 20

/** DB 行(public.sync_sources の snake_case)→ SyncSource。 */
export function sourceFromDb(row: Record<string, unknown> | null | undefined): SyncSource | null {
  if (!row) return null
  return normalizeSource({
    id: typeof row.id === 'number' ? row.id : null,
    name: typeof row.name === 'string' ? row.name : '',
    spreadsheetId: typeof row.spreadsheet_id === 'string' ? row.spreadsheet_id : '',
    worksheet: typeof row.worksheet === 'string' ? row.worksheet : null,
    codeColumn: typeof row.code_column === 'string' ? row.code_column : undefined,
    includeColumns: Array.isArray(row.include_columns) ? (row.include_columns as string[]) : [],
    excludeColumns: Array.isArray(row.exclude_columns) ? (row.exclude_columns as string[]) : [],
    filterColumn: typeof row.filter_column === 'string' && row.filter_column.trim() ? row.filter_column : null,
    filterValues: Array.isArray(row.filter_values) ? (row.filter_values as string[]) : [],
    rename: (row.rename ?? {}) as Record<string, string>,
    enabled: row.enabled !== false,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
    updatedBy: typeof row.updated_by === 'string' ? row.updated_by : null,
  })
}

/** SyncSource → DB の insert/update payload(id が null のとき=id 無し = 新規 insert)。 */
/** DB に書く1データセットの行(snake_case)。Insert/Update の形と一致させる(database.types.ts)。 */
export interface SyncSourceDbRow {
  id?: number
  name: string
  spreadsheet_id: string
  worksheet: string | null
  code_column: string
  include_columns: string[]
  exclude_columns: string[]
  filter_column: string | null
  filter_values: string[]
  rename: Record<string, string>
  enabled: boolean
  updated_at: string
}

export function sourceToDb(source: SyncSource): SyncSourceDbRow {
  const db: SyncSourceDbRow = {
    name: source.name,
    spreadsheet_id: source.spreadsheetId,
    worksheet: source.worksheet,
    code_column: source.codeColumn,
    include_columns: source.includeColumns,
    exclude_columns: source.excludeColumns,
    filter_column: source.filterColumn,
    filter_values: source.filterValues,
    rename: source.rename,
    enabled: source.enabled,
    updated_at: new Date().toISOString(),
  }
  if (source.id !== null) db.id = source.id
  return db
}

/** シートヘッダーから取り込み対象カラムを選ぶ(codeColumn は常に保持)。 */
export function selectColumns(headers: string[], source: SyncSource): string[] {
  let columns = headers
  if (source.includeColumns.length > 0) {
    columns = headers.filter((h) => source.includeColumns.includes(h))
  } else if (source.excludeColumns.length > 0) {
    columns = headers.filter((h) => !source.excludeColumns.includes(h))
  }
  if (source.codeColumn && !columns.includes(source.codeColumn)) {
    columns.push(source.codeColumn)
  }
  return columns
}

/** worksheets 一覧から対象タイトルを選ぶ(一致なしなら最初)。 */
export function sheetTitleFor(titles: string[], worksheet: string | null): string | null {
  if (titles.length === 0) return null
  if (worksheet) {
    const hit = titles.find((t) => t === worksheet)
    if (hit) return hit
  }
  return titles[0] ?? null
}

export interface SyncRow {
  code: string
  payload: Record<string, string>
}

export interface SheetMapping {
  headers: string[]
  columns: string[]
  rows: SyncRow[]
  /** code が空だった行の数 */
  skipped: number
  /** filterColumn の行フィルタで除外した行数(code 空スキップとは別カウント) */
  filtered: number
  /** codeColumn がヘッダーに無い(設定ミス。取り込み不可) */
  codeColumnMissing: boolean
  codeColumn: string
  /** filterColumn がヘッダーに無い(設定ミス。取り込み不可) */
  filterColumnMissing: boolean
  filterColumn: string | null
}

/** シート1行目(ヘッダー)を正規化する。空セルは column_N にする(取り込み・セル参照で共通)。 */
export function normalizeHeaders(rawHeader: unknown[]): string[] {
  return rawHeader.map((h, i) => (h === undefined || h === null || h === '' ? `column_${i + 1}` : String(h)))
}

/** payload キー → シート上の元カラム名(rename を逆引き。rename 対象が無ければキー名そのまま)。 */
export function sourceColumnFor(payloadKey: string, rename: Record<string, string>): string {
  for (const [from, to] of Object.entries(rename)) {
    if (to === payloadKey) return from
  }
  return payloadKey
}

/**
 * シートの値(1行目=ヘッダー)を { code, payload } へ変換する。
 * - code が空の行はスキップ
 * - filterColumn 設定時は、そのカラムの値(trim)が filterValues のいずれかと一致する行のみ取り込む。
 *   filterValues が空リストなら「値が非空なら有効」(有効レコードの印字なら何でも通す)
 * - 空値(undefined/'')は payload に載せない
 * - rename のキー変換を適用
 */
export function mapSheetRows(values: unknown[][], source: SyncSource): SheetMapping {
  const headers = normalizeHeaders(values[0] ?? [])
  const columns = selectColumns(headers, source)
  const codeIdx = headers.indexOf(source.codeColumn)

  if (codeIdx === -1) {
    return {
      headers, columns, rows: [], skipped: 0, filtered: 0,
      codeColumnMissing: true, codeColumn: source.codeColumn,
      filterColumnMissing: false, filterColumn: source.filterColumn,
    }
  }

  const filterIdx = source.filterColumn ? headers.indexOf(source.filterColumn) : -1
  if (source.filterColumn && filterIdx === -1) {
    return {
      headers, columns, rows: [], skipped: 0, filtered: 0,
      codeColumnMissing: false, codeColumn: source.codeColumn,
      filterColumnMissing: true, filterColumn: source.filterColumn,
    }
  }

  const rows: SyncRow[] = []
  let skipped = 0
  let filtered = 0
  for (const row of values.slice(1)) {
    const code = String(row?.[codeIdx] ?? '').trim()
    if (!code) {
      skipped += 1
      continue
    }
    if (source.filterColumn && filterIdx !== -1) {
      const flag = String(row?.[filterIdx] ?? '').trim()
      const valid = source.filterValues.length > 0 ? source.filterValues.includes(flag) : flag !== ''
      if (!valid) {
        filtered += 1
        continue
      }
    }
    const payload: Record<string, string> = {}
    for (const col of columns) {
      if (col === source.codeColumn) continue
      const idx = headers.indexOf(col)
      if (idx === -1) continue
      const value = row?.[idx]
      if (value === undefined || value === null || value === '') continue
      payload[source.rename[col] ?? col] = String(value)
    }
    rows.push({ code, payload })
  }

  return {
    headers, columns, rows, skipped, filtered,
    codeColumnMissing: false, codeColumn: source.codeColumn,
    filterColumnMissing: false, filterColumn: source.filterColumn,
  }
}

/**
 * 1回の取り込み(import)で読めるシートの行数上限(暴走防止。超えたら truncated=true を返す)。
 * 旧 sync の MAX_SYNC_ROWS と同じ値。スマホ側の保存上限は shared/utils/offline の OFFLINE_ITEM_MAX。
 */
export const MAX_IMPORT_ROWS = 5000

/** import の1バッチ行数(画面のダウンロードループ。API 側で 1〜IMPORT_PAGE_MAX に補正)。 */
export const IMPORT_PAGE_SIZE = 100
export const IMPORT_PAGE_MAX = 200

export function clampImportLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isInteger(n)) return IMPORT_PAGE_SIZE
  return Math.min(IMPORT_PAGE_MAX, Math.max(1, n))
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * import の分页カーソル。**取り込み対象行の offset**(文字列)がカーソル。
 * code カーソルと違い、シート側の並び(数値昇順とは限らない)をそのまま保つ。末尾が limit 未満なら null。
 */
export function importNextCursor(rows: SyncRow[], offset: number, limit: number): string | null {
  if (rows.length < limit) return null
  return String(offset + rows.length)
}

/** /api/sync-config の応答(データセット一覧の取得・保存で同じ形を返す)。 */
export interface SourceConfigResponse {
  sources: SyncSource[]
  /** サービスアカウント鍵がサーバー側に設定されているか(未設定なら取り込み・書き込み不可) */
  serviceAccountConfigured: boolean
  updatedBy: string | null
  updatedAt: string | null
  /** DB のソース行が 0(0007 未適用 or 初回)。UI は既定値をそのまま表示する */
  rowMissing: boolean
}

/** /api/source-preview の応答(取り込み前にシート実測を見せる。書き込まない。読み取り失敗は ok:false)。 */
export interface SourcePreviewResponse {
  sourceId: number
  /** シート読み取りが成功したか(false なら error に理由。API は落ちない) */
  ok: boolean
  error: string | null
  sheetTitle: string | null
  /** 設定の worksheet がシート一覧にあったか(不一致は最初のシートにフォールバック) */
  worksheetMatched: boolean
  /** シートに存在したワークシート名(不一致のときの案内用) */
  sheetTitles: string[]
  headers: string[] | null
  /** 取り込み対象カラム(選別後) */
  columns: string[]
  /** payload に載るキー名(rename 適用後) */
  payloadKeys: string[]
  /** シートのデータ行数(ヘッダーを除く。上限前の実測) */
  dataRows: number
  /** 取り込み対象行数 */
  rowCount: number
  /** code が空でスキップされた行数 */
  skipped: number
  /** 行フィルタ(filterColumn/filterValues)で除外した行数 */
  filtered: number
  codeColumnMissing: boolean
  filterColumnMissing: boolean
  /** MAX_IMPORT_ROWS 超で切り捨てられたか(import は打ち切る) */
  truncated: boolean
  /** 先頭サンプル(プレビュー表示用) */
  sample: SyncRow[]
}

/** /api/import の応答(1バッチ。画面は cursor が null になるまで繰り返す)。 */
export interface ImportPageResponse {
  sourceId: number
  sheetTitle: string
  headers: string[]
  columns: string[]
  /** 取り込み対象の総行数(上限打ち切り後の値) */
  total: number
  rows: SyncRow[]
  /** 次のページカーソル(offset の文字列)。最終ページは null */
  nextCursor: string | null
  skipped: number
  filtered: number
  truncated: boolean
  /** この取り込みの基準日時(ISO。シート索引のキャッシュと同じ読み取りを指す) */
  importedAt: string
}

/** セット番号 → A1 の列表記(0基点: 0='A', 25='Z', 26='AA')。 */
export function columnLetter(index: number): string {
  let n = index + 1
  let letters = ''
  while (n > 0) {
    n -= 1
    letters = String.fromCharCode(65 + (n % 26)) + letters
    n = Math.floor(n / 26)
  }
  return letters
}

/**
 * A1 のシート名パート。常にシングルクォート 1組で囲む(「フォームの回答 1」のような
 * 空白入りタイトルを range に載せるため)。A1 規則通り、タイトル内の ' は 2個重ねてエスケープする。
 */
export function quoteSheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`
}

/** セル番地の A1 表記(rowNumber は 1起点。ヘッダーが 1行目なのでデータ行は index+2)。 */
export function a1Cell(title: string, colIndex: number, rowNumber: number): string {
  return `${quoteSheetTitle(title)}!${columnLetter(colIndex)}${rowNumber}`
}

/** プレビューに出す payload キー名(rename 適用後の集合)。 */
export function payloadKeysOf(rows: SyncRow[]): string[] {
  const keys = new Set<string>()
  for (const row of rows) for (const k of Object.keys(row.payload)) keys.add(k)
  return [...keys].sort()
}
