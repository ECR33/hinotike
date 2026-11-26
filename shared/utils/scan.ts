/**
 * スキャンの「記録モード」の共通ロジック(純粋関数)。
 *
 * 設定は DB(public.scan_modes)が正。doc/docs/scan-modes.md の設計に対応する。
 * - モード = 1行。**1つのデータセット(public.sync_sources の行)に紐づく**。記録列名はシート固有なので、
 *   複数シートを扱うようになった今は mode ごとに sourceId を持つ(2026-11-22 の複数データセット化)。
 * - モードは /scan の「新しい記録を作る」と管理欄から動的に増減する。
 * - actions = 書くカラムの組(済/未フラグ列 + 日時列)。シートヘッダー名は rename 前の実名
 *   (remark-update と同じ基準。payload キーは rename/rename 前名どちらでも指定できる)。
 * - payload キーは**スマホ内のミラー**(IndexedDB)に写す。データ本体の Supabase テーブルは無い.
 * - 証跡(scan_events)は「いつ・誰が・どのモードで・何を書いたか」の履歴。シートセルは1値しか残らない。
 * Nuxt 依存の import は置かない(server / shared / CLI どちらでも読めるように)。
 */
import type { SyncSource } from './sync'

/** 済/未 フラグ列に書く既定の値(未に戻す = 空文字でクリア)。 */
export const SCAN_FLAG_VALUE = '済'
export const SCAN_UNFLAG_VALUE = '未'

/** モード名の長さ上限(チップ表示と UNIQUE キー用)。 */
export const SCAN_MODE_NAME_MAX_LENGTH = 40

/** 1モードの actions 上限(1回のフラグ+日時組 × 3種まで。膨張による高コストな一括書き込みを防ぐ)。 */
export const SCAN_ACTIONS_MAX = 3

/** カラム名・payload キー名の長さ上限(items.ts の KEY_NAME_MAX_LENGTH と同じ意図)。 */
export const SCAN_COLUMN_NAME_MAX_LENGTH = 40

/** フラグに書く値の長さ上限。 */
export const SCAN_LITERAL_MAX_LENGTH = 24

/** 1回の flush で送れる code 数上限(バッチ書き込みと payload 更新の膨張を防ぐ)。 */
export const SCAN_CODES_MAX = 100

/** code(=QRコードの値)の長さ上限(remark の上限より小さく。不正な長QRを照会しない)。 */
export const SCAN_CODE_MAX_LENGTH = 120

/** 連続スキャンの同一コード無視窓(ミリ秒)。同じQRを2回読んで二重記録するのを防ぐ。 */
export const SCAN_DEDUPE_WINDOW_MS = 2500

/** flush の自動確定に必要な件数(画面側の既定値)。 */
export const SCAN_AUTO_FLUSH_COUNT = 5

export type ScanDedupe = 'warn' | 'skip' | 'allow'

/** 記録モードの1つの書く組。シートヘッダー名(rename 前)を正とする。 */
export interface ScanAction {
  /** 済/未 フラグ列のヘッダー名(必須) */
  column: string
  /** 日時列のヘッダー名(空 = 日時を書かない = 表示側は「日時があれば済」で導出できないのでフラグのみ) */
  columnAt: string
  /** フラグ列に書く値(空 = SCAN_FLAG_VALUE) */
  literal: string
  /** items payload に反映するフラグキー(空 = column) */
  payloadKey: string
  /** items payload に反映する日時キー(空 = columnAt) */
  payloadAtKey: string
}

export interface ScanMode {
  /** 未作成(新規)は null。DB の serial id */
  id: number | null
  /** このモードが書き込むデータセット(public.sync_sources の id)。null = 未設定(API は 400 にする) */
  sourceId: number | null
  name: string
  actions: ScanAction[]
  dedupe: ScanDedupe
  /** true = 氏名を確認してから記録(来場・チェックイン)。false = 読み取った順にそのまま記録(棚卸し・配布) */
  confirmBeforeRecord: boolean
  /** items に見つからない code を拒否するか */
  requireFound: boolean
  enabled: boolean
  updatedAt: string | null
  updatedBy: string | null
}

/** /api/scan-config の応答(取得・保存で同じ形を返す。?sourceId= を渡すとそのシートの実測も添える)。 */
export interface ScanConfigResponse {
  modes: ScanMode[]
  /** データセット(取り込み定義)の一覧。/scan の「どのデータの作業か」の選択と取り込みの根 */
  sources: SyncSource[]
  /** サービスアカウント鍵がサーバー側に設定されているか(列作成・書き込みはこれが必要) */
  serviceAccountConfigured: boolean
  /** scan_modes の行が 0(シード未投入)。UI は既定プリセットを表示する */
  rowMissing: boolean
  /** query の sourceId が DB に無い(API は黙って null を返す。画面は「ソースが見つかりません」を出す) */
  sourceMissing: boolean
  /** 対象シートを読み取れたときのワークシート名(設定画面の注記用。読み取り失敗・未設定は null) */
  sheetTitle: string | null
  /** 対象シートの実際のヘッダー名(設定画面の「シートに列が無い」判定用。null は不明) */
  sheetHeaders: string[] | null
}

/** モードがシートに書く列名(フラグ + 日時。空と重複は除く)。 */
export function modeColumns(mode: ScanMode): string[] {
  const out: string[] = []
  for (const action of mode.actions) {
    if (action.column && !out.includes(action.column)) out.push(action.column)
    if (action.columnAt && !out.includes(action.columnAt)) out.push(action.columnAt)
  }
  return out
}

/** シートのヘッダーに無い列(スキャンすると 400 になる列)。headers が不明(null)なら [] を返す(確定できないので注記しない)。 */
export function modeColumnsMissing(mode: ScanMode, headers: string[] | null | undefined): string[] {
  if (!headers) return []
  return modeColumns(mode).filter((name) => !headers.includes(name))
}

/** 取り込みカラム(include_columns)に載っていない列。載せないと次の取り込みで端末のミラーに載らない。 */
export function modeColumnsOutsideInclude(mode: ScanMode, includeColumns: string[]): string[] {
  if (includeColumns.length === 0) return []
  return modeColumns(mode).filter((name) => !includeColumns.includes(name))
}

/** 記録の status(scan_events と画面の共通語)。 */
export type ScanStatus = 'ok' | 'duplicate' | 'not_found' | 'sheet_missing' | 'write_failed' | 'skipped'

/**
 * 画面・API が受け取る生データを ScanMode に正規化する。
 * 不正値は項目単位で補正する(throw すると記録作成画面が固まるため、sync の normalizeSettings と同じ方針)。
 */
function cleanName(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().slice(0, max)
}

export function normalizeScanDedupe(raw: unknown): ScanDedupe {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (value === 'skip' || value === 'allow') return value
  return 'warn'
}

function normalizeAction(raw: unknown): ScanAction | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  // DB(jsonb)は snake_case、画面/API は camelCase なので両方読む(片方だけで落ちると設定が壊れる)。
  const column = cleanName(obj.column, SCAN_COLUMN_NAME_MAX_LENGTH)
  if (!column) return null
  const columnAt = cleanName(obj.columnAt ?? obj.column_at, SCAN_COLUMN_NAME_MAX_LENGTH)
  const literal = cleanName(obj.literal, SCAN_LITERAL_MAX_LENGTH) || SCAN_FLAG_VALUE
  const payloadKey = cleanName(obj.payloadKey ?? obj.payload_key, SCAN_COLUMN_NAME_MAX_LENGTH) || column
  const payloadAtKey = cleanName(obj.payloadAtKey ?? obj.payload_at_key, SCAN_COLUMN_NAME_MAX_LENGTH) || columnAt
  return { column, columnAt, literal, payloadKey, payloadAtKey }
}

export function normalizeScanMode(raw: Partial<ScanMode> | null | undefined): ScanMode | null {
  if (!raw || typeof raw !== 'object') return null
  const name = cleanName(raw.name, SCAN_MODE_NAME_MAX_LENGTH)
  if (!name) return null
  // sourceId は DB(camel の JSON と snake の jsonb 両方許容)・画面のどちらでも読む(未設定は null)
  const rawSource = (raw as Record<string, unknown>).sourceId ?? (raw as Record<string, unknown>).source_id
  const sourceId = typeof rawSource === 'number' ? rawSource : Number(rawSource)
  const actions: ScanAction[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(raw.actions) ? raw.actions : []) {
    const action = normalizeAction(item)
    if (!action || seen.has(action.column)) continue
    seen.add(action.column)
    actions.push(action)
    if (actions.length >= SCAN_ACTIONS_MAX) break
  }
  if (actions.length === 0) return null
  return {
    id: typeof raw.id === 'number' && Number.isInteger(raw.id) ? raw.id : null,
    sourceId: Number.isInteger(sourceId) ? sourceId : null,
    name,
    actions,
    dedupe: normalizeScanDedupe(raw.dedupe),
    confirmBeforeRecord: raw.confirmBeforeRecord === true,
    requireFound: raw.requireFound !== false,
    enabled: raw.enabled !== false,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : null,
  }
}

export function normalizeScanModes(raw: unknown): ScanMode[] {
  const items = Array.isArray(raw) ? raw : []
  const seen = new Set<string>()
  const out: ScanMode[] = []
  for (const item of items) {
    const mode = normalizeScanMode(item as Partial<ScanMode>)
    if (!mode || seen.has(mode.name)) continue
    seen.add(mode.name)
    out.push(mode)
  }
  return out
}

/** 指定データセットに紐づくモードだけを選ぶ(/scan のモードチップはソース単位)。 */
export function modesForSource(modes: ScanMode[], sourceId: number | null): ScanMode[] {
  if (sourceId === null) return modes
  return modes.filter((m) => m.sourceId === sourceId || m.sourceId === null)
}

/** DB 行(public.scan_modes の snake_case)→ ScanMode。row の値は unknown なのでここで型を確定する。 */
export function scanModeFromDb(row: Record<string, unknown> | null | undefined): ScanMode | null {
  if (!row) return null
  return normalizeScanMode({
    id: typeof row.id === 'number' ? row.id : null,
    sourceId: typeof row.source_id === 'number' ? row.source_id : null,
    name: typeof row.name === 'string' ? row.name : '',
    actions: Array.isArray(row.actions) ? (row.actions as ScanAction[]) : [],
    dedupe: normalizeScanDedupe(row.dedupe),
    confirmBeforeRecord: row.confirm_before_record === true,
    requireFound: row.require_found !== false,
    enabled: row.enabled !== false,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
    updatedBy: typeof row.updated_by === 'string' ? row.updated_by : null,
  })
}

/** ScanMode → DB の upsert payload(id なし = 新規。singleton 行ではないので行単位)。 */
/** DB に書く1モードの行(snake_case)。scan_modes の Insert/Update の形と一致させる(database.types.ts)。 */
export interface ScanModeDbRow {
  id?: number
  source_id: number | null
  name: string
  actions: { column: string; column_at: string; literal: string; payload_key: string; payload_at_key: string }[]
  dedupe: string
  confirm_before_record: boolean
  require_found: boolean
  enabled: boolean
  updated_at: string
}

export function scanModeToDb(mode: ScanMode): ScanModeDbRow {
  const db: ScanModeDbRow = {
    name: mode.name,
    source_id: mode.sourceId,
    actions: mode.actions.map((a) => ({
      column: a.column,
      column_at: a.columnAt,
      literal: a.literal,
      payload_key: a.payloadKey,
      payload_at_key: a.payloadAtKey,
    })),
    dedupe: mode.dedupe,
    confirm_before_record: mode.confirmBeforeRecord,
    require_found: mode.requireFound,
    enabled: mode.enabled,
    updated_at: new Date().toISOString(),
  }
  if (mode.id !== null) db.id = mode.id
  return db
}

/**
 * 既定のプリセット2つ(migrations/0006 の insert と同じ。片方を変えたらもう片方も直す)。
 * sourceId は null で置く(DB の行は migrations/0007 で最初のデータセットに紐づく。
 * DB 行が無いときに画面が既定を表示する経路では、ソースを選んでから保存する)。
 */
export const DEFAULT_SCAN_MODES: ScanMode[] = [
  {
    id: null,
    sourceId: null,
    name: 'チケット配布',
    actions: [{ column: '配布済', columnAt: '配布日時', literal: SCAN_FLAG_VALUE, payloadKey: '配布済', payloadAtKey: '配布日時' }],
    dedupe: 'warn',
    confirmBeforeRecord: false,
    requireFound: true,
    enabled: true,
    updatedAt: null,
    updatedBy: null,
  },
  {
    id: null,
    sourceId: null,
    name: 'チェックイン',
    actions: [{ column: '来場済', columnAt: '来場日時', literal: SCAN_FLAG_VALUE, payloadKey: '来場済', payloadAtKey: '来場日時' }],
    dedupe: 'warn',
    confirmBeforeRecord: true,
    requireFound: true,
    enabled: true,
    updatedAt: null,
    updatedBy: null,
  },
]

/**
 * payload から済/未を出す正規化(表示用)。
 * フラグの値は '済'/'未'/任意文字列/空どれでも来るので、空・'未'・未系文字列は「未」、
 * それ以外の非空は「済み」とする。フラグが空でも日時があれば「済」扱い(日時列のみのモード救済)。
 */
/** フラグ値が「未」側(空・'未'・no/false 系)かどうか。それ以外の非空は「済み」とする。 */
function isUnflag(flag: string): boolean {
  const value = flag.toLowerCase()
  return flag === SCAN_UNFLAG_VALUE || value === 'no' || value === 'false' || value === 'ng' || value === 'n' || value === '未'
}

export function recordState(
  payload: Record<string, unknown> | null | undefined,
  flagKey: string,
  atKey = '',
): '済' | '未' {
  const flag = typeof payload?.[flagKey] === 'string' ? (payload[flagKey] as string).trim() : ''
  if (flag && !isUnflag(flag)) return '済'
  const at = typeof payload?.[atKey] === 'string' ? (payload[atKey] as string).trim() : ''
  if (at) return '済'
  return '未'
}

/** モードの表示用サマリ(チップと記録履歴に「何を記録するモードか」を添える)。 */
export function scanModeSummary(mode: ScanMode): string {
  const parts = mode.actions.map((a) => (a.columnAt ? `${a.column} / ${a.columnAt}` : a.column))
  const tail = mode.confirmBeforeRecord ? '確認してから記録' : '連続で記録'
  return `${parts.join('・')}(${tail})`
}

/**
 * 連続スキャンの重複判定(画面側)。同じ code を SCAN_DEDUPE_WINDOW_MS 以内に読んだら無視する。
 * 処理中(inFlight)の code も無視する(書き込み中に同じQRを読んで二重記録するのを防ぐ)。
 */
export function isSameScan(code: string, lastCode: string, lastAtMs: number, nowMs: number, windowMs = SCAN_DEDUPE_WINDOW_MS): boolean {
  if (!code || code !== lastCode) return false
  return nowMs - lastAtMs < windowMs
}

/**
 * ISO 文字列を JST の固定表記にする(SSR とクライアントで同じ文字列にするため手計算)。
 * toLocaleString / Intl は ICU の挙動差で hydration mismatch の原因になる(README の方針)。
 * 不正値は空文字。秒は出さない(シートセルと履歴行は分までで十分)。
 */
export function formatJst(iso: string | null | undefined): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms + 9 * 60 * 60 * 1000)
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (JST)`
}

/** 現在時刻の JST 表記(シートに書く日時文字列。DB に載せる ISO は `new Date().toISOString()`)。 */
export function nowJst(): string {
  return formatJst(new Date().toISOString())
}

/** 記録の1件(画面のセッション欄と flush 応答の共通形状)。 */
export interface ScanRecordEntry {
  code: string
  status: ScanStatus
  name: string | null
  /** 実際に書いた値(payload キー → 値)。書いていない件は空 */
  written: Record<string, string>
  /** 書き込んだセル番地(フラグ列。A1 表記) */
  range: string | null
  /** この読み取りの時刻(ISO。画面は formatJst で出す) */
  at: string
}

/** スキャンの照合の応答形(読み取り専用。端末ミラーが作る。サーバー照合 API は撤去した)。 */
export interface ScanCheckResponse {
  modeId: number
  code: string
  status: ScanStatus
  name: string | null
  /** 現在の状態(payload から正規化した済/未)。pending card の「未」「済み(日時)」表示用 */
  state: '済' | '未'
  /** 記録済みの日時(payload に有れば JST 表記) */
  recordedAt: string
  /** この読み取りの時刻(ISO) */
  at: string
}

/** /api/scan-flush の応答。 */
export interface ScanFlushResponse {
  modeId: number
  sheetTitle: string
  results: ScanRecordEntry[]
  /** 実際にシートへ書き込んだ件数 */
  wrote: number
  /** 証跡 scan_events の insert が成功したか(false でもシート書き込みは完了している。監査の欠落だけを注記で出す) */
  auditWritten: boolean
}

/** /api/scan-columns の応答(シートに記録列を作る)。 */
export interface ScanColumnsResponse {
  sheetTitle: string
  created: string[]
  /** 既にヘッダーにあった列(作らない) */
  existing: string[]
  headers: string[]
  /** sync_sources.include_columns に追記したか(次回取り込みで payload が消えないようにする) */
  includeColumnsUpdated: boolean
  includeColumns: string[]
}

/** 記録履歴の1行(scan_events)。 */
export interface ScanHistoryRow {
  /** insertion 順の連番(新しい順のキーセット分页のカーソル) */
  seq: number
  code: string
  modeName: string
  name: string | null
  actorEmail: string | null
  status: ScanStatus
  written: Record<string, string>
  sheetRange: string | null
  /** ISO。画面は formatJst で JST 表記にする */
  at: string
}

/** /api/scan-history の応答(seq 降順キーセットカーソル分页)。 */
export interface ScanHistoryResponse {
  rows: ScanHistoryRow[]
  /** 次のページカーソル(seq の文字列)。最終ページは null */
  nextCursor: string | null
  total: number
}

export const SCAN_HISTORY_PAGE_SIZE = 25
export const SCAN_HISTORY_PAGE_MAX = 100

/** クエリ参数の limit を安全な範囲に補正(items.ts の clampLimit と同じ意図)。 */
export function clampHistoryLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isInteger(n)) return SCAN_HISTORY_PAGE_SIZE
  return Math.min(SCAN_HISTORY_PAGE_MAX, Math.max(1, n))
}

/** 分页カーソル。末尾が limit 未満なら null(最終ページ)。降順なので末尾の seq が次ページの上限になる。 */
export function historyNextCursor(rows: ScanHistoryRow[], limit: number): string | null {
  if (rows.length < limit) return null
  const last = rows[rows.length - 1]?.seq
  return typeof last === 'number' ? String(last) : null
}

/** payload から済/未と記録日時を出す(モードの payload キーを使う)。server の scanRun と画面(オフライン check)で共通。 */
export function stateOfPayload(payload: Record<string, unknown>, mode: ScanMode): { state: '済' | '未'; recordedAt: string } {
  let state: '済' | '未' = '未'
  let recordedAt = ''
  for (const action of mode.actions) {
    const one = recordState(payload, action.payloadKey, action.payloadAtKey)
    if (one === '済') state = '済'
    const at = payload[action.payloadAtKey]
    if (typeof at === 'string' && at.trim() && !recordedAt) recordedAt = at.trim()
  }
  return { state, recordedAt }
}

/** 記録の status を画面用の文言に落とす(固定文言。内部メッセージは出さない)。 */
export function scanStatusMessage(status: ScanStatus): string {
  if (status === 'ok') return '記録しました'
  if (status === 'duplicate') return '重複(既に記録済み)'
  if (status === 'not_found') return '見つかりません(items にコードがありません)'
  if (status === 'sheet_missing') return 'シート行がありません(再同期が必要です)'
  if (status === 'write_failed') return 'シート書き込み失敗'
  if (status === 'skipped') return '記録しない(重複設定)'
  return '不明な状態'
}
