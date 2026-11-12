/**
 * Google Spreadsheet → Supabase の同期ロジック(純粋関数)。
 *
 * 設定は DB(public.sync_settings)の 1 行が正。管理 UI(/sync)から編集できる。
 * DEFAULT_SYNC_SETTINGS は初回シード用(migrations/0003 の insert と同じ値)。
 * 取り込みの選別・rename・code 空スキップはここが唯一の実装で、
 * API(server/api/sync-*)と CLI(scripts/sync-sheets.ts)が同じ関数を使う。
 */

export interface SyncSettings {
  /** Google スプレッドシート ID(未設定なら同期できない) */
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
   * 行の有効/無効を表すカラム名。null/空 = 行フィルタなし(全行读取込み対象)。
   * 指定すると、このカラムの値が filterValues に合う行のみ取り込む(値の比較は trim 後の完全一致)。
   */
  filterColumn: string | null
  /** filterColumn の許容値(複数可)。空リスト = そのカラムの値が非空なら有効 */
  filterValues: string[]
  /** true = 確定時に、今回のシートで取り込み対象だった code に無い items 行を削除する(prune) */
  pruneOnCommit: boolean
  /** payload のキー名を書き換える: { "元カラム名": "新キー名" } */
  rename: Record<string, string>
  /** 書き込み先のテーブル名 */
  targetTable: string
}

/** migrations/0003_sync_settings.sql のシード行と同じ値(片方を変えたらもう片方も直す)。 */
export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
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
  pruneOnCommit: false,
  rename: { '領収書が必要な方はチェックをお願いします。': '領収書' },
  targetTable: 'items',
}

/** テーブル名: 小文字英数字と _ のみ(PostgREST のテーブル名として安全な形に限定)。 */
export function isSafeTableName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(name)
}

/** スプレッドシート ID: 英数字・ハイフン・アンダースコア(Google が発行する形)。 */
export function isSafeSpreadsheetId(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{10,120}$/.test(name)
}

/**
 * UI/API から来た生データを正規化する。不正な値は DEFAULT にフォールバックする
 * (throw すると保存画面が固まるため、項目単位で補正する)。
 * spreadsheetId は空文字を許す(未設定 = 同期不可。API 側で 400 にする)。
 */
export function normalizeSettings(raw: Partial<SyncSettings> | null | undefined): SyncSettings {
  const base = DEFAULT_SYNC_SETTINGS
  const spreadsheetId =
    typeof raw?.spreadsheetId === 'string'
      ? raw.spreadsheetId.trim()
      : ''
  return {
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
    pruneOnCommit: raw?.pruneOnCommit === true,
    rename:
      raw?.rename && typeof raw.rename === 'object' && !Array.isArray(raw.rename)
        ? Object.fromEntries(
            Object.entries(raw.rename).filter(
              ([from, to]) => typeof from === 'string' && from.trim() && typeof to === 'string' && to.trim(),
            ).map(([from, to]) => [from.trim(), (to as string).trim()]),
          )
        : {},
    targetTable: isSafeTableName(raw?.targetTable) ? raw!.targetTable! : base.targetTable,
  }
}

/** DB 行(public.sync_settings の snake_case)→ SyncSettings。 */
export function settingsFromDb(row: Record<string, unknown> | null | undefined): SyncSettings {
  if (!row) return { ...DEFAULT_SYNC_SETTINGS }
  return normalizeSettings({
    spreadsheetId: typeof row.spreadsheet_id === 'string' ? row.spreadsheet_id : '',
    worksheet: typeof row.worksheet === 'string' ? row.worksheet : null,
    codeColumn: typeof row.code_column === 'string' ? row.code_column : undefined,
    includeColumns: Array.isArray(row.include_columns) ? (row.include_columns as string[]) : [],
    excludeColumns: Array.isArray(row.exclude_columns) ? (row.exclude_columns as string[]) : [],
    filterColumn: typeof row.filter_column === 'string' && row.filter_column.trim() ? row.filter_column : null,
    filterValues: Array.isArray(row.filter_values) ? (row.filter_values as string[]) : [],
    pruneOnCommit: row.prune_on_commit === true,
    rename: (row.rename ?? {}) as Record<string, string>,
    targetTable: typeof row.target_table === 'string' ? row.target_table : undefined,
  })
}

/** SyncSettings → DB の insert/upsert payload。singleton 行(id=1)を確定させる。 */
export function settingsToDb(s: SyncSettings): Record<string, unknown> {
  return {
    id: 1,
    spreadsheet_id: s.spreadsheetId,
    worksheet: s.worksheet,
    code_column: s.codeColumn,
    include_columns: s.includeColumns,
    exclude_columns: s.excludeColumns,
    filter_column: s.filterColumn,
    filter_values: s.filterValues,
    prune_on_commit: s.pruneOnCommit,
    rename: s.rename,
    target_table: s.targetTable,
  }
}

/** シートヘッダーから取り込み対象カラムを選ぶ(codeColumn は常に保持)。 */
export function selectColumns(headers: string[], settings: SyncSettings): string[] {
  let columns = headers
  if (settings.includeColumns.length > 0) {
    columns = headers.filter((h) => settings.includeColumns.includes(h))
  } else if (settings.excludeColumns.length > 0) {
    columns = headers.filter((h) => !settings.excludeColumns.includes(h))
  }
  if (settings.codeColumn && !columns.includes(settings.codeColumn)) {
    columns.push(settings.codeColumn)
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

/**
 * シートの値(1行目=ヘッダー)を { code, payload } へ変換する。
 * - code が空の行はスキップ
 * - filterColumn 設定時は、そのカラムの値(trim)が filterValues のいずれかと一致する行のみ取り込む。
 *   filterValues が空リストなら「値が非空なら有効」(有効レコードの印字なら何でも通す)
 * - 空値(undefined/'')は payload に載せない
 * - rename のキー変換を適用
 */
export function mapSheetRows(values: unknown[][], settings: SyncSettings): SheetMapping {
  const rawHeader = values[0] ?? []
  const headers = rawHeader.map((h, i) => (h === undefined || h === null || h === '' ? `column_${i + 1}` : String(h)))
  const columns = selectColumns(headers, settings)
  const codeIdx = headers.indexOf(settings.codeColumn)

  if (codeIdx === -1) {
    return {
      headers, columns, rows: [], skipped: 0, filtered: 0,
      codeColumnMissing: true, codeColumn: settings.codeColumn,
      filterColumnMissing: false, filterColumn: settings.filterColumn,
    }
  }

  const filterIdx = settings.filterColumn ? headers.indexOf(settings.filterColumn) : -1
  if (settings.filterColumn && filterIdx === -1) {
    return {
      headers, columns, rows: [], skipped: 0, filtered: 0,
      codeColumnMissing: false, codeColumn: settings.codeColumn,
      filterColumnMissing: true, filterColumn: settings.filterColumn,
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
    if (settings.filterColumn && filterIdx !== -1) {
      const flag = String(row?.[filterIdx] ?? '').trim()
      const valid = settings.filterValues.length > 0 ? settings.filterValues.includes(flag) : flag !== ''
      if (!valid) {
        filtered += 1
        continue
      }
    }
    const payload: Record<string, string> = {}
    for (const col of columns) {
      if (col === settings.codeColumn) continue
      const idx = headers.indexOf(col)
      if (idx === -1) continue
      const value = row?.[idx]
      if (value === undefined || value === null || value === '') continue
      payload[settings.rename[col] ?? col] = String(value)
    }
    rows.push({ code, payload })
  }

  return {
    headers, columns, rows, skipped, filtered,
    codeColumnMissing: false, codeColumn: settings.codeColumn,
    filterColumnMissing: false, filterColumn: settings.filterColumn,
  }
}

/** upsert のバッチサイズ(CLI・API 共通)。 */
export const UPSERT_BATCH = 200

/** シート読み込みの上限行数(暴走防止。超えたら API が 400 にする)。 */
export const MAX_SYNC_ROWS = 5000

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** /api/sync-config の応答(設定の取得・保存で同じ形を返す)。 */
export interface SyncConfigResponse {
  settings: SyncSettings
  /** サービスアカウント鍵がサーバー側に設定されているか(未設定なら同期実行不可) */
  serviceAccountConfigured: boolean
  updatedBy: string | null
  updatedAt: string | null
  /** DB の設定行が無い(マイグレーション未適用 or 初回)。UI は既定値をそのまま表示する */
  rowMissing: boolean
}

/** /api/sync-preview の応答(確定前に見せる要約)。 */
export interface SyncPreviewResponse {
  sheetTitle: string
  /** シートに存在したワークシート名(設定の worksheet が不一致だったときの案内用) */
  sheetTitles: string[]
  /** 設定の worksheet が実際のシート名と一致したか(不一致は最初のシートにフォールバック) */
  worksheetMatched: boolean
  headerCount: number
  /** ヘッダー名の一覧(選別判定の材料として UI に出す) */
  headers: string[]
  /** 取り込み対象カラム(選別後) */
  columns: string[]
  /** payload に載るキー名(rename 適用後) */
  payloadKeys: string[]
  dataRows: number
  /** code が空でスキップされた行数 */
  skipped: number
  /** 行フィルタ(filterColumn/filterValues)で除外した行数 */
  filtered: number
  /** prune(削除)が設定で有効か */
  pruneEnabled: boolean
  /** 確定時に削除される予定の items 行数(シートに無い code。pruneEnabled のときのみ計算) */
  deleteCount: number
  /** 既に code が存在する行数(update 対象) */
  updateCount: number
  /** 新規 code の行数(insert 対象) */
  insertCount: number
  /** 先頭サンプル(プレビュー表示用) */
  sample: SyncRow[]
  /** MAX_SYNC_ROWS を超えて切り捨てられたか */
  truncated: boolean
}

/** /api/sync-commit の応答。 */
export interface SyncCommitResponse {
  sheetTitle: string
  targetTable: string
  upserted: number
  insertCount: number
  updateCount: number
  skipped: number
  /** 行フィルタ(filterColumn/filterValues)で除外した行数 */
  filtered: number
  /** prune(設定有効時)で実際に削除した items 行数 */
  deleted: number
}
