/**
 * ローカルデータセット(=旧「オフラインモード」)の共通ロジック(純粋関数)。
 *
 * 設計(2026-11-22 の複数データセット化):
 * - **データ本体は端末内に置く**。作業前に「どのデータセット(spreadsheet)で作業するか」を決め、
 *   `GET /api/import` でそのシートを取り込み(IndexedDB の `items` ストア、key=`sourceId|code`)する。
 *   Supabase の `items` テーブルは使わない(シートが唯一の正)。
 * - 「オフライン」という語は**ローカルデータで作業する**の意味として残す: 取り込み済みなら
 *   通信があってもなくても照会・一覧・チェックインは端末内のミラーに対して走る。
 * - 照会・一覧・項目キーの照合はこのファイルの**1つの実装**が server(/api/items-* のシート由来版)と
 *   画面(IndexedDB のミラー)の両方で同じ意味で効く。PostgREST の jsonb パス照会 duplicate は撤去した。
 * - 記録の待機列(queue)は端末に残る。任意のタイミングで `POST /api/scan-offline-flush` を送り、
 *   サーバーがシートを再読して行位置と現在の状態を確定して書く。**日時はオフライン時の読み取り時刻(at)を保持**。
 *   既に「済」だった行は dedupe で書き込まず duplicate/skipped を返す。
 * - シート行の存在(sheet_missing)はローカルミラーでは判定できない(payload を鏡として扱う)。
 *   確定時のサーバー側で初めて確定する。
 * Nuxt 依存の import は置かない(scan.ts / items.ts / sync.ts と同じ方針。IndexedDB・localStorage のアクセスは
 * 画面側の app/utils/offlineStore.ts に置く)。
 */
import {
  ITEM_GROUP_KEY,
  ITEM_NAME_KEY,
  ITEM_REMARK_KEY,
  ITEM_YEAR_KEY,
  clampLimit,
  compareFacetValues,
  facetCounts,
  facetPairCounts,
  missingPairCount,
  nextCursor,
  normalizeFilter,
  normalizeKeyFilters,
  normalizePairs,
  normalizeRemarkState,
  normalizeSelection,
  payloadValue,
  type FacetOption,
  type FacetPairCount,
  type ItemKeyEntry,
  type ItemRowData,
  type ItemsKeysResponse,
} from './items'
import { parseRegistrationCode } from './registration'
import { normalizeScanModes, SCAN_CODE_MAX_LENGTH, stateOfPayload, type ScanCheckResponse, type ScanConfigResponse, type ScanMode, type ScanRecordEntry, type ScanStatus } from './scan'
import { normalizeSource, normalizeSources, type SyncSource } from './sync'

// ── 保存先・上限の定数 ────────────────────────────────────

/** localStorage の有効化フラグ+メタのキー(JSON の OfflineMeta)。 */
export const OFFLINE_META_STORAGE_KEY = 'hinotike-offline-meta'

/**
 * localStorage の「今どちらのデータセットで作業するか」の id(取り込みの有無と**独立**に保存する)。
 * 取り込み済みならメタの sourceId と同じ。未取り込みでも、選んだシートへ照会・記録を一致させるために
 * ページ(/scan・/scan-settings・/items・/result)が同じ id を読む。破損値は null(サーバー側が既定を選ぶ)。
 */
export const ACTIVE_SOURCE_STORAGE_KEY = 'hinotike-active-source'

export function parseActiveSource(raw: string | null | undefined): number | null {
  if (!raw) return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

export function serializeActiveSource(sourceId: number): string {
  return String(sourceId)
}

/**
 * SW のページキャッシュ名(`nuxt.config.ts` の workbox `cacheName` と**同じ値**にする)。
 * 缓存された SSR HTML には氏名・email が載る(/items は1ページ目を SSR で描画する)ので、
 * 端末データの削除では IndexedDB と一緒にこれも消す(`app/utils/offlineStore.ts` の `offlineClearPageCache`)。
 */
export const OFFLINE_PAGE_CACHE_NAME = 'hinotike-pages'

/** IndexedDB の DB 名 / stores(snapshot = メタ1行、items = code→行、queue = オフライン記録の待機)。 */
export const OFFLINE_DB_NAME = 'hinotike-offline'
export const OFFLINE_DB_VERSION = 1
export const OFFLINE_SNAPSHOT_STORE = 'snapshot'
export const OFFLINE_SNAPSHOT_KEY = 'meta'
export const OFFLINE_ITEMS_STORE = 'items'
export const OFFLINE_QUEUE_STORE = 'queue'

/**
 * items ストアのキー。複数データセットを同じストアに住ませるため `sourceId|code` の複合キーにする
 * (別のシートの同じ code が別人を指す可能性があるので、code 単独のキーは使えない)。
 * 旧キー(code 単独)の行は取り込み時の clear で消える。
 */
export function datasetKey(sourceId: number, code: string): string {
  return `${sourceId}|${code}`
}

/** 取り込みのダウンロード上限(server の MAX_IMPORT_ROWS より大きく、端末 Quota 防止の打ち切り)。 */
export const OFFLINE_ITEM_MAX = 20000
/** 取り込みの1バッチ(/api/import の limit。IMPORT_PAGE_SIZE と同じ既定)。 */
export const OFFLINE_PAGE_BATCH = 100
/** ローカルキューの上限(地下で読み取りをため続ける暴走防止。超えた読み取りは記録しない)。 */
export const OFFLINE_QUEUE_MAX = 2000
/** 1回の復旧確定リクエストで送れる entry 数(scan-flush の SCAN_CODES_MAX と同系統の上限)。 */
export const OFFLINE_FLUSH_MAX = 300
/** 復旧確定の1モード group の chunk(scanRun の SCAN_CODES_MAX と同じ。画面側が chunk して送る)。 */
export const OFFLINE_FLUSH_CHUNK = 100

// ── 型 ────────────────────────────────────────────────────

/** IndexedDB の snapshot ストア(と localStorage に置くフラグ)が持つメタ。 */
export interface OfflineMeta {
  /** 有効化フラグ(localStorage に置く。解除は false で書く = データは残る) */
  enabled: boolean
  /** このスナップショットがどのデータセット(spreadsheet)から取り込まれたか */
  sourceId: number
  /**
   * 取り込み時の利用者の uid(`auth.uid()` の UUID)。ミラーは「取り込んだ端末の利用者」のデータなので、
   * 別ユーザが同じブラウザにログインしたときはこの判定でローカル作業を無効にする(端末の氏名を読ませない)。
   * 旧形(無いメタ)は `parseOfflineMeta` が null = 無効扱いで再取り込みを促す。
   */
  uid: string
  /** 取り込み時のデータセット名(denormalize。設定編集・削除後も画面に残す) */
  sourceName: string
  /** 取り込み時のソース定義スナップショット(商品表示順と「載る予定キー」の注記に使う) */
  source: SyncSource
  /** 取り込んだ時刻(ISO。画面は formatJst で出す) */
  snapshotAt: string
  /** 保存した行の件数 */
  itemCount: number
  /** /api/scan-config のスナップショット(モード一覧・シート情報。ローカルモード選択と欠け列注記に使う) */
  config: ScanConfigResponse
  /** 上限 OFFLINE_ITEM_MAX で打ち切ったダウンロードなら true(全件ではない旨の注記を出す) */
  capped?: boolean
}

/** 記録の1読み取りの待機(IndexedDB の queue ストアの行。復旧後にフラッシュする)。 */
export interface OfflineQueueEntry {
  /** ストアのキー(makeOfflineQueueId で作る) */
  id: string
  /** この読み取りがどのデータセットの作業か(復旧時にモードが消えていても正しいシートへ書くための保険) */
  sourceId: number
  modeId: number
  /** モード名(denormalize。フラッシュ時にモードが消えていても画面に残す) */
  modeName: string
  code: string
  /** ローカル check の状態(復旧後の flush 側で ok/duplicate/skipped/sheet_missing... に確定する) */
  status: ScanStatus
  name: string | null
  /** 上書き指定(確認モードの「上書き」)。復旧後の flush でも dedupe の優先として効く */
  overwrite: boolean
  /** オフラインでの読み取り時刻(ISO。復旧後のシート日時・証跡 at はこれを使う) */
  at: string
}

/** /api/scan-offline-flush が受け取る1件(画面側が OfflineQueueEntry から作る)。 */
export interface OfflineFlushInput {
  modeId: number
  code: string
  /** オフライン時の読み取り時刻(ISO)。不正は '' = サーバー側が確定時刻にフォールバックする */
  at: string
  overwrite: boolean
}

/** /api/scan-offline-flush の1結果(ScanRecordEntry + どのモードの確定か)。 */
export interface OfflineFlushResultEntry extends ScanRecordEntry {
  modeId: number
}

/** /api/scan-offline-flush の応答(画面側は modeId|code で entry に戻す)。 */
export interface OfflineFlushResponse {
  results: OfflineFlushResultEntry[]
  /** シートに実際に書き込んだ件数(ok + 上書きした duplicate) */
  wrote: number
  /** 既に済だったため書き込まなかった件数(duplicate/skipped)。画面の「既に済だった N件」注記 */
  skipped: number
  /** 証跡 scan_events の insert が成功したか(false でもシート書き込みは完了している) */
  auditWritten: boolean
  sheetTitle: string
}

// ── メタの localStorage 往復 ──────────────────────────────

/** localStorage の JSON 文字列→ OfflineMeta。不正・破損は null(無効扱い)。 */
export function parseOfflineMeta(raw: string | null | undefined): OfflineMeta | null {
  if (!raw) return null
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>
  if (typeof o.snapshotAt !== 'string' || !Number.isFinite(Date.parse(o.snapshotAt))) return null
  if (typeof o.itemCount !== 'number' || !Number.isInteger(o.itemCount) || o.itemCount < 0) return null
  // 旧形(データセット前のスナップショット)は sourceId が無いので無効扱い = 再取り込みを促す
  const sourceId = typeof o.sourceId === 'number' ? o.sourceId : Number(o.sourceId)
  if (!Number.isInteger(sourceId) || sourceId <= 0) return null
  // uid が無いメタ(旧形)も無効扱い。ミラーは取り込んだ利用者のデータなので、
  // 「誰の端末データか」が無ければ別ユーザのログインで氏名を読めてしまう(端末での漏洩防止)。
  if (typeof o.uid !== 'string' || o.uid.trim() === '') return null
  const source = normalizeSource(o.source as Partial<SyncSource> | null)
  if (!source.name) return null
  const config = o.config as Partial<ScanConfigResponse> | null
  if (!config || typeof config !== 'object' || !Array.isArray(config.modes)) return null
  return {
    enabled: o.enabled === true,
    sourceId,
    uid: o.uid.trim(),
    sourceName: typeof o.sourceName === 'string' ? o.sourceName : source.name,
    source,
    snapshotAt: o.snapshotAt,
    itemCount: o.itemCount,
    // モードとソースは normalize で補正(古い形や欠ける項目があってもモード・ソース選択が壊れないようにする)
    config: {
      modes: normalizeScanModes(config.modes),
      sources: normalizeSources(config.sources),
      serviceAccountConfigured: config.serviceAccountConfigured === true,
      rowMissing: config.rowMissing === true,
      sourceMissing: config.sourceMissing === true,
      sheetTitle: typeof config.sheetTitle === 'string' ? config.sheetTitle : null,
      sheetHeaders: Array.isArray(config.sheetHeaders) ? config.sheetHeaders.filter((c) => typeof c === 'string') : null,
    },
    capped: o.capped === true,
  }
}

export function serializeOfflineMeta(meta: OfflineMeta): string {
  return JSON.stringify(meta)
}

/**
 * ミラーが「今ログインしている利用者」のデータかどうか(uid 紐づけ)。
 * どちらかの uid が欠けているときも false(保守側): uid 未解決(通信が無い・認証状態が無い)では
 * ローカル作業を使わず API 照会に戻す。オフラインの画面は SSR が埋め込んだ auth-state の uid で判定できる。
 */
export function mirrorBelongsToUser(
  meta: OfflineMeta | null | undefined,
  uid: string | null | undefined,
): boolean {
  if (!meta || typeof meta.uid !== 'string' || meta.uid === '') return false
  if (typeof uid !== 'string' || uid === '') return false
  return meta.uid === uid
}

/** ミラーのメタが「有効 = ローカル作業に使える」か(有効フラグ + uid 紐づけの両方を満たす)。 */
export function localWorkAllowed(
  meta: OfflineMeta | null | undefined,
  uid: string | null | undefined,
): boolean {
  return meta?.enabled === true && mirrorBelongsToUser(meta, uid)
}

// ── キュー ────────────────────────────────────────────────

/** キューエントリのキー。同じ ms に同時読み取りが来ても衝突しないようにランダム末尾を添える。 */
export function makeOfflineQueueId(modeId: number, code: string, at: string): string {
  return `${modeId}|${code}|${at}|${Math.random().toString(36).slice(2, 10)}`
}

/**
 * /api/scan-offline-flush の body entries を正規化する。
 * 不正項目は項目単位で捨てる(throw すると1壊れた entry が確定全体を止める)。
 * 利用者登録QR(`hinotike-registration:`)は記録対象ではないので除外する(scan-check と同じ基準)。
 */
export function normalizeOfflineEntries(raw: unknown, max = OFFLINE_FLUSH_MAX): OfflineFlushInput[] {
  const items = Array.isArray(raw) ? raw : []
  const out: OfflineFlushInput[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const modeId = typeof o.modeId === 'number' ? o.modeId : Number(o.modeId)
    if (!Number.isInteger(modeId)) continue
    const code = typeof o.code === 'string' ? o.code.trim() : ''
    if (!code || code.length > SCAN_CODE_MAX_LENGTH) continue
    if (parseRegistrationCode(code)) continue
    const at = typeof o.at === 'string' && Number.isFinite(Date.parse(o.at)) ? o.at : ''
    out.push({ modeId, code, at, overwrite: o.overwrite === true })
    if (out.length >= max) break
  }
  return out
}

// ── オフラインの check(payload をシート/DB の鏡として扱う)─

/**
 * オフラインの scan-check 相当(items スナップショットの payload から氏名・済/未・記録日時を出す)。
 * シート行の存在判定はオフラインではできないので sheet_missing は出さない(復旧後の flush 側で確定)。
 * payload が無い = ローカルスナップショットに見つからない → requireFound のモードは not_found。
 */
export function offlineScanCheckResponse(
  modeId: number,
  mode: ScanMode,
  code: string,
  payload: Record<string, unknown> | null | undefined,
  at: string,
): ScanCheckResponse {
  const found = payload !== null && payload !== undefined
  const p = payload ?? {}
  const name = typeof p[ITEM_NAME_KEY] === 'string' ? (p[ITEM_NAME_KEY] as string) : null
  const { state, recordedAt } = stateOfPayload(p, mode)
  const status: ScanStatus = !found && mode.requireFound ? 'not_found' : state === '済' ? 'duplicate' : 'ok'
  return { modeId, code, status, name, state, recordedAt, at }
}

// ── オフラインの items 一覧(/api/items-list の照会意味をローカルで再現する)──

/**
 * 部分一致のローカル照合。server の ilike は `%pat%` の大文字小文字無視(アクセントは区別)なので
 * `toLowerCase()` の includes で再現する。入力は normalizeFilter で trim・長打ち済みの文字列を受け取る。
 */
function containsLocalText(text: string, pattern: string): boolean {
  return text.toLowerCase().includes(pattern.toLowerCase())
}

/** ローカル照合の payload 値の扱い: payloadValue の文字化(string/number/boolean を SQL の text に写す)。 */
function payloadText(payload: Record<string, unknown> | null | undefined, key: string): string {
  return payloadValue(payload, key)
}

/** 画面が送る items-list の query と同じ形の入力(正規化はこの関数が shared の normalize を使う)。 */
export interface OfflineItemsQueryInput {
  code?: unknown
  name?: unknown
  remark?: unknown
  remarkState?: unknown
  years?: unknown
  groups?: unknown
  pairs?: unknown
  filters?: unknown
  cursor?: unknown
  limit?: unknown
}

/** items-list の応答と同じ形(キーセットカーソル + exact count)。 */
export interface OfflineItemsPage {
  rows: ItemRowData[]
  nextCursor: string | null
  total: number
}

/**
 * スナップショットの rows(code 昇順とは限らない — IDB の key は文字列なので数値順に並べ直す)から
 * items-list と**同じ意味**で絞り込み+分页する。キーセットカーソルは `code > cursor`(数値比較)。
 * total は一致する総件数(exact)で、UI の「N 件中 M 件表示」にそのまま使える。
 *
 * server の PostgREST との対応:
 *  - ilike(部分一致・大文字小文字無視) → containsLocalText(NULL は一致しない。payloadValue は
 *    欠落・null を '' にするが '' はどんな pattern も含まないので NULL と同じ挙動になる)
 *  - payload->>key の text(文字はそのまま・number/boolean は文字化) → payloadValue と同じ
 *  - `in.` の完全一致 → selection は normalizeSelection で trim 済み。payload の raw 値と完全一致で比べる
 *    (server と同じ「trim した chip 値 vs raw payload 値」の非対称をそのまま再現する)
 *  - pairs(年 AND 組、ペア同士 OR)、remark/key の present・absent(欠落・null・空文字 = absent)、
 *    filters の contains/in(present/absent と異モードは AND)も items-list と同じ组合で効く。
 */
export function offlineItemsQuery(rows: ItemRowData[], input: OfflineItemsQueryInput, limit?: unknown): OfflineItemsPage {
  const codePattern = normalizeFilter(input.code)
  const namePattern = normalizeFilter(input.name)
  const remarkPattern = normalizeFilter(input.remark)
  const remarkState = normalizeRemarkState(input.remarkState)
  const years = normalizeSelection(input.years)
  const groups = normalizeSelection(input.groups)
  const pairs = normalizePairs(input.pairs)
  const keyFilters = normalizeKeyFilters(input.filters)
  const cursorText = typeof input.cursor === 'string' ? input.cursor.trim() : ''
  const cursorNum = cursorText ? Number(cursorText) : Number.NaN
  // server は int code を数値で gt する。不正カーソル(数値でない)は照会側が落ちる代わりに無視する
  // (ローカルのカーソルは offlineItemsQuery が last code から作るため常に数値。防御扱い)
  const hasCursor = cursorText !== '' && Number.isFinite(cursorNum)
  // items-list の clampLimit と同じ補正(画面は limit を input と引数両方に載せるのでどちらでも効く)
  const pageSize = clampLimit(limit ?? input.limit)

  const sorted = [...rows].sort((a, b) => compareFacetValues(a.code, b.code))
  const matches = sorted.filter((row) => {
    if (hasCursor && !(Number(row.code) > cursorNum)) return false
    const payload = row.payload ?? {}
    if (codePattern && !containsLocalText(row.code, codePattern)) return false
    if (namePattern && !containsLocalText(payloadText(payload, ITEM_NAME_KEY), namePattern)) return false
    const remarkText = payloadText(payload, ITEM_REMARK_KEY)
    if (remarkPattern && !containsLocalText(remarkText, remarkPattern)) return false
    // 備考の有無(items-list の present=not null & ''でない、absent=欠落・null・空文字)
    if (remarkState === 'present' && remarkText === '') return false
    if (remarkState === 'absent' && remarkText !== '') return false
    if (years.length && !years.includes(payloadText(payload, ITEM_YEAR_KEY))) return false
    if (groups.length && !groups.includes(payloadText(payload, ITEM_GROUP_KEY))) return false
    if (pairs.length) {
      const year = payloadText(payload, ITEM_YEAR_KEY)
      const group = payloadText(payload, ITEM_GROUP_KEY)
      if (!pairs.some((pair) => pair.year === year && pair.group === group)) return false
    }
    for (const filter of keyFilters) {
      const text = payloadText(payload, filter.key)
      if (filter.mode === 'present') {
        if (text === '') return false
      } else if (filter.mode === 'absent') {
        if (text !== '') return false
      } else if (filter.mode === 'contains') {
        // normalizeKeyFilters が contains の空値を捨てているので value は常に非空
        if (!containsLocalText(text, filter.value)) return false
      } else {
        if (!filter.values.includes(text)) return false
      }
    }
    return true
  })

  const page = matches.slice(0, pageSize)
  return { rows: page, nextCursor: nextCursor(page, pageSize), total: matches.length }
}

/** items-facets の応答と同じ形(items.vue の ItemsFacets と同一の shape)。 */
export interface OfflineFacets {
  years: FacetOption[]
  groups: FacetOption[]
  pairs: FacetPairCount[]
  missingPairs: number
  scanned: number
  truncated: boolean
}

/**
 * スナップショットから年・組の選択肢(facet)を導出する。server の items-facets と同じ shared 関数
 * (facetCounts / facetPairCounts / missingPairCount)を使い、payload を全件スキャンする
 * (server の ITEM_FACET_SCAN_LIMIT 上限はオフラインには無いので truncated は常に false)。
 */
export function offlineFacets(rows: ItemRowData[]): OfflineFacets {
  const scanned = rows.map((row) => ({
    year: payloadText(row.payload, ITEM_YEAR_KEY),
    group: payloadText(row.payload, ITEM_GROUP_KEY),
  }))
  return {
    years: facetCounts(scanned.map((row) => row.year)),
    groups: facetCounts(scanned.map((row) => row.group)),
    pairs: facetPairCounts(scanned),
    missingPairs: missingPairCount(scanned),
    scanned: scanned.length,
    truncated: false,
  }
}

/**
 * payload キーの発見(一覧の「任意項目」絞り込み・表示用)。server の items-keys とローカル一覧が同じ関数を使う。
 *
 * 2つの源の和集合を出す(items-keys の設計そのまま):
 *  - **定義から**: 取り込み定義(includeColumns + rename)で「載る予定のキー」(configKeys を渡す側)。
 *    includeColumns が空のときは rename の新キー名だけ(シートヘッダーは実データ側で出る)。
 *  - **実データから**: rows の payload をスキャンして実際に出現したキー。
 * キーごとにあり/なしの件数と値の選択肢を出す。定義に載る予定だがまだ出現していないキーは
 * seenInData=false で出す(画面は消さずに注記する)。codeColumn は payload に載らないので渡さない(呼び側で除く)。
 * 端末ミラー側は configKeys を渡さない(定義のスナップショットが無い/古い場合) = 実データのみ。
 */
export function datasetKeys(rows: ItemRowData[], configKeys: string[] = []): ItemsKeysResponse {
  const candidates = new Set(configKeys)
  const present = new Map<string, number>()
  const seen = new Set<string>()
  const values = new Map<string, string[]>()
  for (const row of rows) {
    const payload = row.payload ?? {}
    for (const [key, value] of Object.entries(payload)) {
      seen.add(key)
      const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)
      // items-list の present と同じ判定(空文字・欠落は absent 側)
      if (text !== '') {
        present.set(key, (present.get(key) ?? 0) + 1)
        values.set(key, [...(values.get(key) ?? []), text])
      }
    }
  }
  // 2つの源の和集合(両方に載るキーは Set で除重する)
  const union = new Set<string>([...candidates, ...seen])
  const keys: ItemKeyEntry[] = []
  for (const key of union) {
    const presentCount = present.get(key) ?? 0
    keys.push({
      key,
      presentCount,
      absentCount: rows.length - presentCount,
      options: facetCounts(values.get(key) ?? []),
      fromConfig: candidates.has(key),
      seenInData: seen.has(key),
    })
  }
  keys.sort((a, b) => a.key.localeCompare(b.key, 'ja'))
  return { keys, scanned: rows.length, truncated: false }
}

/** 端末ミラー(定義スナップショットなし)からのキー発見 = 実データのみ。旧名互換で残す。 */
export function offlineKeys(rows: ItemRowData[]): ItemsKeysResponse {
  return datasetKeys(rows, [])
}

/** 取り込み定義から「載る予定のキー」を作る(items-keys の設定側。codeColumn は除く)。 */
export function configuredPayloadKeys(source: SyncSource): string[] {
  const out: string[] = []
  if (source.includeColumns.length > 0) {
    for (const col of source.includeColumns) {
      if (col === source.codeColumn) continue
      out.push(source.rename[col] ?? col)
    }
  } else {
    for (const to of Object.values(source.rename)) out.push(to)
  }
  return out
}
