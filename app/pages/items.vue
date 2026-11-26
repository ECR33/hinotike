<script setup lang="ts">
/**
 * items レコードの一覧(app/components/ItemRow.vue が行部品)。
 *
 * 保護は app/middleware/auth.global.ts(デフォルト拒否+ホワイトリスト)で行うので
 * ページ単位の middleware は不要(グローバルミドルウェアが登録済み利用者だけ通す)。
 *
 * 表示は全件を一括で出さない: code 昇順のキーセットカーソルで1バッチ(ITEM_PAGE_SIZE)ずつ追記する。
 * 最下部の sentinel が画面に出た時点で IntersectionObserver が次のページを読み、sentinel が
 * まだ見えている限り追記し続ける(1バッチで viewport が埋まらない場合もここで自己継続する)。
 * IntersectionObserver が無い環境では手動ボタンにフォールバックする。
 *
 * 検索は code・氏名・備考の部分一致(incremental search): 入力を SEARCH_DEBOUNCE_MS でまとめ、
 * 条件が変わるたびリストを reset + 1ページ目から取り直す。応答は generation で比較して
 * 後発の検索に負けた古い応答を捨て、乱順応答でリストが古い条件の結果に戻るのを防ぐ。
 * URL と検索条件は同期しない(タイプごとに router.replace しない。初期値だけ ?code=&name=&years=&groups=&pairs=&remark=&remarkState= を読む)。
 *
 * 行タップで /result に開いて一覧に戻ると、絞り込み条件・読み込み済みの行・スクロール位置を
 * そのまま復活させる(keepalive。複数の絞り込み結果を1件ずつ開いて確認する用途)。
 * 条件は URL に写らないので、画面更新(再SSR)では初期条件に戻る。
 *
 * 一覧・年組の選択肢・項目キーは**すべて端末内のミラー(IndexedDB の取り込みデータ)**から解決する。
 * server 側の items 照会 API(`/api/items-list` / `items-facets` / `items-keys`)は無くなったので、この画面は
 * 通信の照会を組まない。SSR は storage を読めないため空で描画し、マウント後にミラーの判定へ切り替える。
 * 未取り込みの端末には「この端末に取り込みしてください」の案内カードを出す(取り込みは「データの設定」(/sync))。
 *
 * 年・組の絞り込み(折りたたみできる1つの欄)は2モード:
 *  - 単独選択: chip の多选択(app/components/FacetChipGroup.vue)。同一 facet 内は OR、年と組の間は AND。
 *  - 組み合わせ選択: 年×組のマトリクス(app/components/YearGroupMatrix.vue)。選んだセル(その年+その組)だけを対象、
 *    セル同士は OR。「1年3組 + 2年1組」のような**対応**を指定できる。
 * モード切替時はもう一方の選択を消す(見えない選択が条件に残らない)。
 * 選択肢は端末ミラーの全行から導出する(`shared/utils/offline` の `offlineFacets`。年・組の値とペアの件数)で、
 * 現在の絞り込み結果には連動しない。
 * chip・セル・リセットはデバウンスを待たずに即適用する。
 * 入力の消去は app/components/ClearableInput.vue(Vuetify の clearable 相当: 値があるとき右端に消去ボタン)。
 *
 * 備考の絞り込み(折りたたみできる1つの欄)は2つの条件:
 *  - 有無: 「すべて / あり / なし」の1行のボタン(3状態)。なし = 備考キーの欠落・null・空文字。
 *  - 文字列: 備考の部分一致入力(code・氏名と同じデバウンスで絞る)。
 * 欄は閉じると1つのボタン行だけなので、条件領域は普段は大きくならない(閉じていても
 *  選択状態はトグルのラベルに出す)。有無ボタンは即適用、入力はデバウンス。
 *
 * 項目の絞り込み(折りたたみできる1つの欄)は**任意の payload キー**の条件。キーの発見は端末ミラーから行う
 * (`shared/utils/offline` の `datasetKeys` が実データの payload に出現したキー + 取り込み時の定義スナップショット
 * の「載る予定」キー(`configuredPayloadKeys`)を有無の件数・選択肢付きで出す)。
 * 備考欄と同じ有無のボタン(あり/なし、即適用)をキーごとに並び、選択肢が少ないキーは
 * chip で値の複数選択(同一キー内 OR)、部分一致は「項目の部分一致」のキーセレクト+入力で絞る。
 * 年・組・氏名・備考は専用の欄があるのでここには並べない(同じキーの二重コントロールを作らない)。
 * 定義に載る予定だがまだ出現していないキー(ボランティア欄の同期待ちなど)は件数0で注記付き出して消さない。
 * キー同士・他の条件はすべて AND。条件は URL `?filters=キー|モード|値`(配列 or カンマ区切り)から初期化する。
 * `"` を含むキー・長さ上限超過のキーは条件にしない(isFilterableKey=false。条件の運搬は URL の
 * `キー|モード|値` spec 文字列なので、キー名に区切り・引用符が混ざると共有リンクで復元できない。
 * 長さ上限も parseKeyFilter と同じ規則)→ ボタン・chip・セレクトを disabled にして表示のみ扱う。
 *
 * 表示のみ(絞り込まない)もキーから選べる: 「行に表示する項目」の chip で選んだキーの値が
 * 一覧行(ItemRow の extra-keys)に追加される(payload のキー名そのままなので照合側の変更不要。
 * localStorage に保存して再訪問でも残る。リセットでは消さない=表示設定は絞り込み条件ではない)。
 */
import {
  ITEM_GROUP_KEY,
  ITEM_NAME_KEY,
  ITEM_PAGE_SIZE,
  ITEM_REMARK_KEY,
  ITEM_YEAR_KEY,
  isFilterableKey,
  normalizeFilter,
  normalizeKeyFilters,
  normalizePairs,
  normalizeRemarkState,
  normalizeSelection,
  pairKey,
  sameKeyFilters,
  serializeKeyFilters,
  quantityName,
  type FacetOption,
  type ItemRowData,
  type ItemKeyEntry,
  type ItemsKeysResponse,
  type KeyFilter,
  type RemarkState,
} from '#shared/utils/items'
import { configuredPayloadKeys, datasetKeys, mirrorBelongsToUser, offlineFacets, offlineItemsQuery, type OfflineFacets, type OfflineItemsPage } from '#shared/utils/offline'
import { formatJst } from '#shared/utils/scan'
import type { MeState } from '#shared/utils/auth'
import type { OfflineItemRow } from '~/utils/offlineStore'

/** 年・組の選択モード(単独選択は OR/AND、組み合わせ選択は年と組の対応)。 */
type FacetMode = 'single' | 'pair'

/**
 * 一覧→照会結果→一覧 の往復でこのページの状態を残す。
 * keepalive はクライアント側の保持(component instance + DOM を deactivate するだけ)なので
 * SSR の描画は通常通り毎回走る。戻ったときに setup は再走しない=条件もfetchも引き継がれる。
 * scrollToTop:false は既定の「別ページへ遷移したら top にスクロール」を止める
 * (スクロールは navigation guard で去る時の位置に戻す。ブラウザの戻る操作も同じ位置になる)。
 */
definePageMeta({ keepalive: true, scrollToTop: false })

const route = useRoute()

/** 初期条件(共有リンク用のクエリだけ読む)。入力・chip・マトリクスから URL は更新しない。 */
const initialCode = normalizeFilter(route.query.code) ?? ''
const initialName = normalizeFilter(route.query.name) ?? ''
const initialYears = normalizeSelection(route.query.years)
const initialGroups = normalizeSelection(route.query.groups)
const initialPairs = normalizePairs(route.query.pairs).map(pairKey)
/** ペア選択が URL にあれば組み合わせモードで始める(単独選択と同時に送られたら両方 AND になる)。 */
const initialMode: FacetMode = initialPairs.length ? 'pair' : 'single'
/** 備考の部分一致入力と有無(URL の `?remark=` / `?remarkState=present|absent` だけ読む)。 */
const initialRemark = normalizeFilter(route.query.remark) ?? ''
const initialRemarkState = normalizeRemarkState(route.query.remarkState)
/** 任意項目の絞り込み(URL の `?filters=キー|モード|値` 配列 or カンマ区切りだけ読む)。 */
const initialKeyFilters = normalizeKeyFilters(route.query.filters)
/** 初期のキー別状態を filters から分解する(画面の操作はキー別、条件の送信は KeyFilter 一覧)。 */
const initialKeyPresence: Record<string, 'any' | 'present' | 'absent'> = {}
const initialKeySelections: Record<string, string[]> = {}
const initialContains = initialKeyFilters.find((f) => f.mode === 'contains') ?? null
/** 行に表示するキー(URL の `?showKeys=`。客户端では localStorage の保存をマウント後に復元する)。 */
const initialShowKeys = normalizeSelection(route.query.showKeys)

const codeInput = ref(initialCode)
const nameInput = ref(initialName)
const remarkInput = ref(initialRemark)
/** 選択済みの facet 値。chip / セルの toggle で即変わる(デバウンスなし)。 */
const years = ref<string[]>(initialYears)
const groups = ref<string[]>(initialGroups)
/** 選択済みのペア(`年:組` の key)。組み合わせモードだけ条件に反映する。 */
const pairs = ref<string[]>(initialPairs)
const facetMode = ref<FacetMode>(initialMode)
/** 備考の有無(any=条件なし / present / absent)。有無ボタンは即適用する。 */
const remarkState = ref<RemarkState>(initialRemarkState)
/** 任意項目の有無(キー → any/present/absent)。未設定のキーは any(条件なし)。ボタンは即適用。 */
const keyPresence = ref<Record<string, 'any' | 'present' | 'absent'>>(initialKeyPresence)
/** 任意項目の値選択(キー → 選択値。同一キー内は OR、in.()。chip は即適用)。 */
const keySelections = ref<Record<string, string[]>>(initialKeySelections)
/** 部分一致検索の対象キーと語(1つのキーだけ絞る。語は code・氏名と同じデバウンス)。 */
const containsKey = ref(initialContains?.key ?? '')
const containsInput = ref(initialContains?.value ?? '')
/** 行に表示するキー(絞り込みせず表示だけ。ItemRow の extra-keys に渡す)。 */
const showKeys = ref<string[]>(initialShowKeys)
/** 年・組の欄は縦に場所を取る(年9×組5 のマトリクス)ので、折りたたんで一覧を先に大きく見せる。
 *  初期選択があれば開いておく(消した条件を隠さない)。 */
const facetSectionOpen = ref(initialYears.length + initialGroups.length + initialPairs.length > 0)
/** 備考の欄も折りたたみ(閉じるとボタン1行だけ。条件領域を普段は大きくしない)。初期条件があれば開く。 */
const remarkSectionOpen = ref(initialRemarkState !== 'any' || !!initialRemark)
/** 項目の欄も折りたたみ(キー数の行が縦に並ぶので閉じて普段は条件領域を増やさない)。初期条件があれば開く。 */
const keySectionOpen = ref(initialKeyFilters.length > 0)
const active = ref<{
  code: string
  name: string
  years: string[]
  groups: string[]
  pairs: string[]
  remark: string
  remarkState: RemarkState
  keyFilters: KeyFilter[]
}>({
  code: initialCode,
  name: initialName,
  years: initialYears,
  groups: initialGroups,
  pairs: initialPairs,
  remark: initialRemark,
  remarkState: initialRemarkState,
  keyFilters: initialKeyFilters,
})

const rows = ref<ItemRowData[]>([])
const total = ref(0)
const cursor = ref<string | null>(null)
const done = ref(false)
const loading = ref(false)
/** 入力の確定待ち(デバウンス中)。行の追記中と区別して「検索中…」を出す。 */
const pending = ref(false)
const errorMessage = useState<string | null>('items-error', () => null)
/**
 * 開発者向けの素のメッセージ(端末ストレージの読み出し失敗の `message`)。
 * 案内は日本語の文言を `errorMessage` に出し、素の文言は折りたたみに出す(運用者には案内だけ見える)。
 */
const errorDetail = useState<string | null>('items-error-detail', () => null)

/** 年・組の選択肢(端末ミラーの全行から導出。絞り込み条件には連動しない)。 */
const facets = useState<OfflineFacets | null>('items-facets', () => null)
const facetError = useState<string | null>('items-facets-error', () => null)

/** 任意項目(payload キー)の発見結果(有無の件数・選択肢)。端末ミラーの payload + 取り込み時の定義から導出する。 */
const keysState = useState<ItemsKeysResponse | null>('items-keys', () => null)
const keysError = useState<string | null>('items-keys-error', () => null)

/**
 * ローカルデータセット(/sync の「このスマホに取り込む」で有効になる)。
 * useOfflineState は onMounted で localStorage のメタを引き当てる(SSR は読めない)。
 * 一覧・facets・項目キーは端末内のミラー(**作業中のデータセット**の行)からローカルで解決する(通信しない)。
 */
const { meta: offlineMeta } = useOfflineState()
/** 認証状態(SSR が埋め込む)。ミラーの uid と比較して別利用者の端末データの一覧表示を防ぐ。 */
const authState = useState<MeState | null>('auth-state', () => null)

/**
 * 端末ミラーの解決状態(一覧・facets・項目キーの解決可否)。
 * SSR と初期 hydration は storage を読めないため `pending`(空の一覧と「この端末のデータを読み込んでいます…」を描画し、
 * マウント後に実際の判定へ切り替える)。`missing` = 未取り込み・`foreign` = 別利用者の取り込み・
 * `uidPending` = 取り込み済みだがログイン状態が未解決。
 */
type MirrorStatus = 'pending' | 'ready' | 'missing' | 'foreign' | 'uidPending'
const mirrorStatus = useState<MirrorStatus>('items-mirror-status', () => 'pending')

/** ミラーの判定(有効フラグ + uid 一致)を `mirrorStatus` に写す。マウントとメタ/認証の変化で打ち直す。 */
function resolveMirrorStatus(): void {
  const m = offlineMeta.value
  if (!m || !m.enabled) {
    mirrorStatus.value = 'missing'
    return
  }
  if (!authState.value?.uid) {
    // uid が解決できていない(通信が無い・認証状態が無い)ときは端末データを使わない(氏名を別ユーザに見せない)
    mirrorStatus.value = 'uidPending'
    return
  }
  mirrorStatus.value = mirrorBelongsToUser(m, authState.value?.uid) ? 'ready' : 'foreign'
}

/** ミラー全行のローカル缓存(ページ追記ごとに getAll を打ち直さない)。 */
let offlineRowsCache: OfflineItemRow[] | null = null
/** 解除・再取り込み・データセットの切替・認証の解決でミラーが変われば缓存を捨て、判定も打ち直す。 */
watch(
  [() => offlineMeta.value?.snapshotAt, () => offlineMeta.value?.sourceId, () => offlineMeta.value?.enabled, () => authState.value?.uid],
  () => {
    offlineRowsCache = null
    resolveMirrorStatus()
    if (mirrorStatus.value === 'ready') void reloadAll()
  },
)

/** 作業中のデータセットのミラー全行(未取り込みは [] = 照合しない)。 */
async function offlineRowsAll(): Promise<OfflineItemRow[]> {
  const sourceId = offlineMeta.value?.sourceId
  if (sourceId == null) return []
  if (!offlineRowsCache) offlineRowsCache = await offlineGetAllItems(sourceId)
  return offlineRowsCache
}
/**
 * 端末ミラーで解決できるか(client のみ・有効フラグ + **uid 一致**)。
 * 同期読みで generation の競合処理と組み合わせて使える(別利用者のミラーの氏名を一覧に出さない)。
 */
function localMirrorActive(): boolean {
  if (!import.meta.client) return false
  const m = readOfflineMetaFromStorage()
  return m?.enabled === true && mirrorBelongsToUser(m, authState.value?.uid)
}
const offlineSnapshotLabel = computed(() => {
  const m = offlineMeta.value
  if (!m) return '端末内のデータ'
  return `"${m.sourceName}" 取り込み ${formatJst(m.snapshotAt)}・${m.itemCount}件${m.capped ? '(上限で打ち切り)' : ''}`
})

/** 項目欄に並べるキー(年・組・氏名・備考は専用欄があるので二重コントロールにしない)。 */
const DEDICATED_ITEM_KEYS = new Set([ITEM_YEAR_KEY, ITEM_GROUP_KEY, ITEM_NAME_KEY, ITEM_REMARK_KEY])
/** chip で値選択できる選択肢数の上限(これを越えるキーは部分一致で絞る。FACET_MAX_VALUES より小さい表示上限)。 */
const KEY_CHIP_MAX = 8

const genericKeys = computed<ItemKeyEntry[]>(() =>
  (keysState.value?.keys ?? []).filter((entry) => !DEDICATED_ITEM_KEYS.has(entry.key)),
)

/** 表示キー chip の選択肢(値は payload キーそのまま。count はあり側の件数=表示の意味情報)。 */
const showKeyOptions = computed<FacetOption[]>(() =>
  genericKeys.value.map((entry) => ({ value: entry.key, count: entry.presentCount })),
)

/** facet 選択の一致判定(順序は無視して集合として同じか。OR の選択順は結果に影響しない)。 */
function sameSelection(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const other = new Set(b)
  return a.every((value) => other.has(value))
}

/** 適用中の絞り込み条件(入力欄の値ではなく active を読む)。 */
interface FilterCondition {
  code: string
  name: string
  years: string[]
  groups: string[]
  pairs: string[]
  remark: string
  remarkState: RemarkState
  keyFilters: KeyFilter[]
}

// IntersectionObserver の有無はクライアントでのしか分からない(SSR では undefined)。
// SSR とクライアントの初回描画を一致させるため初期値は false(フォールバックボタンを出す)とし、
// マウント後に実際の判定へ切り替える。
const ioSupported = ref(false)

// 検索条件の変更で増やす番号。応答が自分の世代より古ければ捨てて上書きしない。
let generation = 0

async function load(opts: { reset: boolean }) {
  if (opts.reset) {
    rows.value = []
    cursor.value = null
    done.value = false
  }
  // 照会できる端末ミラーが無ければ行を追記しない(案内カードが理由を出す)。
  // localMirrorActive は storage の同期読みでの再確認(メタの状態が後から変わった追記を止め、
  // 解除された直後の追記が別利用者のミラーの氏名を出さない)。
  if (done.value || mirrorStatus.value !== 'ready' || !localMirrorActive()) return

  const gen = generation
  const code = active.value.code
  const name = active.value.name
  const remark = active.value.remark
  const remarkStateApplied = active.value.remarkState
  const keyFiltersApplied = active.value.keyFilters
  // facet は applyFilters で active に写してから load を呼ぶので、ここで読んだ値は適用済み条件
  const selectedYears = years.value
  const selectedGroups = groups.value
  const selectedPairs = pairs.value
  const cur = opts.reset ? null : cursor.value

  loading.value = true
  errorMessage.value = null
  errorDetail.value = null
  try {
    // 端末内のミラーから絞り込み+分页する(`offlineItemsQuery` が一覧の照合意味そのもの。
    // キーセットカーソルは `code > cursor` の数値比較で、total は一致する総件数(exact))
    const page: OfflineItemsPage = offlineItemsQuery(
      await offlineRowsAll(),
      {
        code,
        name,
        years: selectedYears,
        groups: selectedGroups,
        pairs: selectedPairs,
        remark,
        // 条件なし(any)は照合側で無視される(送信条件の「送らない」と同じ意味)
        remarkState: remarkStateApplied,
        // 任意項目の絞り込みは spec 文字列の配列で受け取る(値に `,` が混ざっても配列なら壊れない)
        filters: serializeKeyFilters(keyFiltersApplied),
        cursor: cur,
        limit: ITEM_PAGE_SIZE,
      },
      ITEM_PAGE_SIZE,
    )
    if (gen !== generation) return // 後発検索の応答が先に適用済みの場合はこの応答を捨てて上書きしない
    rows.value = opts.reset ? page.rows : [...rows.value, ...page.rows]
    cursor.value = page.nextCursor
    total.value = page.total
    done.value = page.nextCursor === null
  } catch (e: unknown) {
    if (gen !== generation) return
    const raw = e instanceof Error ? e.message : String(e)
    errorMessage.value = '端末内のデータの読み出しに失敗しました(IndexedDB が使えない・開けない環境です)'
    errorDetail.value = raw
    done.value = true // 失敗した以上これ以上の追記はできない
  } finally {
    if (gen === generation) loading.value = false
  }
}

/** 年・組の選択肢を端末ミラーの全行から導出する(失敗しても一覧は出せるので facetError だけ立てる)。 */
async function loadFacets(): Promise<void> {
  facetError.value = null
  try {
    facets.value = offlineFacets(await offlineRowsAll())
  } catch (e: unknown) {
    facetError.value = `端末内のデータの読み出しに失敗しました(${e instanceof Error ? e.message : String(e)})`
  }
}

/**
 * 任意項目(payload キー)の発見結果を端末ミラーから導出する(失敗しても一覧と他の欄は出せるので keysError だけ立てる)。
 * 実データに出現したキー + 取り込み時の定義スナップショットの「載る予定」キー(`configuredPayloadKeys`)を出す
 * (定義に載る予定だがまだ出現していないキーは件数0・注記付きで残す)。
 */
async function loadKeys(): Promise<void> {
  keysError.value = null
  try {
    const all = await offlineRowsAll()
    const meta = offlineMeta.value
    keysState.value = datasetKeys(all, meta ? configuredPayloadKeys(meta.source) : [])
  } catch (e: unknown) {
    keysError.value = `端末内のデータの読み出しに失敗しました(${e instanceof Error ? e.message : String(e)})`
  }
}

const SEARCH_DEBOUNCE_MS = 250
let debounceTimer: ReturnType<typeof setTimeout> | undefined

/** 行に表示するキーのローカル保存(表示設定。絞り込み条件とは別に再訪問で復元する)。 */
const SHOW_KEYS_STORAGE_KEY = 'items-show-keys'

function currentCondition(): FilterCondition {
  return {
    code: normalizeFilter(codeInput.value) ?? '',
    name: normalizeFilter(nameInput.value) ?? '',
    years: [...years.value],
    groups: [...groups.value],
    pairs: [...pairs.value],
    remark: normalizeFilter(remarkInput.value) ?? '',
    remarkState: remarkState.value,
    keyFilters: currentKeyFilters(),
  }
}

/** キー別状態(有無・値選択・部分一致1キー)を送信用の KeyFilter 一覧にまとめる。 */
function currentKeyFilters(): KeyFilter[] {
  const out: KeyFilter[] = []
  for (const [key, state] of Object.entries(keyPresence.value)) {
    if (state === 'present' || state === 'absent') out.push({ key, mode: state, value: '', values: [] })
  }
  for (const [key, values] of Object.entries(keySelections.value)) {
    if (values.length) out.push({ key, mode: 'in', value: '', values: [...values] })
  }
  const containsValue = normalizeFilter(containsInput.value)
  if (containsKey.value && containsValue) {
    out.push({ key: containsKey.value, mode: 'contains', value: containsValue, values: [] })
  }
  return out
}

function sameCondition(a: FilterCondition, b: FilterCondition): boolean {
  return (
    a.code === b.code &&
    a.name === b.name &&
    sameSelection(a.years, b.years) &&
    sameSelection(a.groups, b.groups) &&
    sameSelection(a.pairs, b.pairs) &&
    a.remark === b.remark &&
    a.remarkState === b.remarkState &&
    sameKeyFilters(a.keyFilters, b.keyFilters)
  )
}

function applyFilters() {
  pending.value = false
  const next = currentCondition()
  if (sameCondition(next, active.value)) return
  active.value = next
  generation += 1
  void load({ reset: true })
}

/** デバウンスの確定待ちを打ち切って即適用する(chip の変更・リセット用)。 */
function applyNow() {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = undefined
  }
  applyFilters()
}

function toggled(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

function toggleYear(value: string) {
  years.value = toggled(years.value, value)
  applyNow()
}

function toggleGroup(value: string) {
  groups.value = toggled(groups.value, value)
  applyNow()
}

/** マトリクスのセル(年と組の対応)を選ぶ。再押で解除(toggled と同じ)。 */
function togglePair(key: string) {
  pairs.value = toggled(pairs.value, key)
  applyNow()
}

/**
 * 選択モードを切り替える。もう一方のモードの選択は消す(表示されない選択が
 * 条件として残ると「何で絞られているか」が分からなくなるため)。
 */
function setMode(next: FacetMode) {
  if (next === facetMode.value) return
  facetMode.value = next
  if (next === 'pair') {
    years.value = []
    groups.value = []
  } else {
    pairs.value = []
  }
  applyNow()
}

/** 備考の有無を選ぶ(すべて=条件なし)。同じ状態を再押は無視する。即適用して欄は開いたまま。 */
function setRemarkState(next: RemarkState) {
  if (next === remarkState.value) return
  remarkState.value = next
  applyNow()
}

/** 任意項目の有無ボタン(あり/なし)。再押で「すべて(条件なし)」に戻る。即適用。 */
function toggleKeyPresence(key: string, mode: 'present' | 'absent') {
  keyPresence.value[key] = keyPresence.value[key] === mode ? 'any' : mode
  applyNow()
}

/** 任意項目の値 chip(複数選択で OR)。再押で解除(toggled と同じ)。即適用。 */
function toggleKeyValue(key: string, value: string) {
  keySelections.value[key] = toggled(keySelections.value[key] ?? [], value)
  applyNow()
}

/** 部分一致の対象キーを選んだ(セレクトは即適用。語の入力はないと条件にならない)。選べないキーは条件にしない。 */
function selectContainsKey(key: string) {
  containsKey.value = isFilterableKey(key) ? key : ''
  applyNow()
}

/** 行に表示するキーを選ぶ(絞り込みではなく表示のみ。条件ではないので applyNow しない)。 */
function toggleShowKey(key: string) {
  showKeys.value = toggled(showKeys.value, key)
  if (import.meta.client) localStorage.setItem(SHOW_KEYS_STORAGE_KEY, JSON.stringify(showKeys.value))
}

/** UI に表示されている条件のどれかが入っているか(リセットボタンの有効判定)。表示キーは条件ではないので数えない。 */
const hasFilters = computed(
  () =>
    !!codeInput.value ||
    !!nameInput.value ||
    !!remarkInput.value ||
    years.value.length > 0 ||
    groups.value.length > 0 ||
    pairs.value.length > 0 ||
    remarkState.value !== 'any' ||
    Object.values(keyPresence.value).some((state) => state !== 'any') ||
    Object.values(keySelections.value).some((values) => values.length > 0) ||
    (!!containsKey.value && !!containsInput.value.trim()),
)

/** 絞り込み条件を一度に消す(code・氏名・年・組・ペア・備考の有無と検索・任意項目の有無と値選択と部分一致)。選択モードと表示キーは維持する。条件がなければ無効。 */
function resetFilters() {
  codeInput.value = ''
  nameInput.value = ''
  remarkInput.value = ''
  years.value = []
  groups.value = []
  pairs.value = []
  remarkState.value = 'any'
  keyPresence.value = {}
  keySelections.value = {}
  containsKey.value = ''
  containsInput.value = ''
  applyNow()
}

/** 折りたたみ欄のラベル(閉じていても選択状態が分かるように件数を出す。ラベルは短く保つ=3トグルが mobile の1行に収まる)。 */
const facetSelectionSummary = computed(() => {
  if (facetMode.value === 'pair') return pairs.value.length ? `${pairs.value.length} セル選択中` : 'なし'
  const parts = []
  if (years.value.length) parts.push(`${years.value.length} 年`)
  if (groups.value.length) parts.push(`${groups.value.length} 組`)
  return parts.length ? parts.join(' + ') : 'なし'
})

/** 備考欄のラベル。閉じていても有無の選択と検索入力が見える(長い入物は省略して短く出す)。 */
const remarkSelectionSummary = computed(() => {
  const presence =
    remarkState.value === 'present' ? 'あり' : remarkState.value === 'absent' ? 'なし' : 'すべて'
  const term = remarkInput.value.trim()
  if (!term) return presence
  const shown = term.length > 8 ? `${term.slice(0, 8)}…` : term
  return `${presence} + 「${shown}」`
})

/** 項目欄のラベル。閉じていても有無・値選択・部分一致の選択数が分かる(長い入物は省略して短く出す)。 */
const keySelectionSummary = computed(() => {
  const n = currentKeyFilters().length
  if (n === 0) return 'なし'
  const term = containsInput.value.trim()
  const shown = term.length > 8 ? `${term.slice(0, 8)}…` : term
  return term ? `${n}項目 + 「${shown}」` : `${n}項目`
})

watch([codeInput, nameInput, remarkInput, containsInput], () => {
  pending.value = true
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined
    applyFilters()
  }, SEARCH_DEBOUNCE_MS)
})

const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null
/** keepalive の表示/非表示旗。非表示中に sentinel が「見えている」扱いになっても追記しない。 */
let pageActive = true
/** 一覧を去った時点のスクロール位置(戻ったときに同じ位置へ戻す)。 */
let savedScrollY = 0

/** sentinel(一覧の末尾)がまだ画面内か(下端から200px 手前を含む)。 */
function sentinelVisible(): boolean {
  if (!import.meta.client) return false
  const el = sentinel.value
  if (!el) return false
  return el.getBoundingClientRect().top < window.innerHeight + 200
}

/** sentinel が見えている限り次のページを追記する(IO の回调がない場合の自己継続もここで処理する)。 */
async function loadMore(): Promise<void> {
  // 去った瞬間に in-flight の追記があると、nextTick の sentinelVisible は detach 済みで
  // true(全 rect が 0)になるのでここで打ち切る(非表示中に全件を読み進めない)。
  if (!pageActive || loading.value || done.value) return
  if (!sentinelVisible()) return
  await load({ reset: false })
  if (!pageActive) return
  await nextTick()
  if (sentinelVisible()) await loadMore()
}

/**
 * 端末ミラーから一覧・年組の選択肢・項目キーをまとめて解決し直す(マウントとメタ/認証の変化で走る)。
 * 取り込みの切替や解除でミラーが変われば缓存 HTML の行とズれるので IDB から読み直す。
 */
async function reloadAll(): Promise<void> {
  await load({ reset: true })
  await loadFacets()
  await loadKeys()
}

onMounted(() => {
  ioSupported.value = typeof IntersectionObserver === 'function'
  // SSR は storage を読めない(『読み込み中…』を描画)。マウントでこの端末のミラーの判定へ切り替えて解決する。
  resolveMirrorStatus()
  if (mirrorStatus.value === 'ready') void reloadAll()
  // 行に表示するキーを localStorage から復元(表示設定。URL の初期指定があればそちらを優先する)。
  if (!showKeys.value.length) {
    try {
      const saved = JSON.parse(localStorage.getItem(SHOW_KEYS_STORAGE_KEY) ?? 'null')
      if (Array.isArray(saved)) {
        showKeys.value = normalizeSelection(saved)
      }
    } catch {
      // 壊れた保存内容は捨てる(次回トグルで上書きされる)
    }
  }
  if (!ioSupported.value || !sentinel.value) return
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore()
    },
    { rootMargin: '0px 0px 200px 0px' },
  )
  observer.observe(sentinel.value)
  // 1ページ目がまだ画面に収まっている場合はスクロールを待たずに追記する
  void loadMore()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  if (debounceTimer) clearTimeout(debounceTimer)
})

/**
 * keepalive の activation/deactivation を navigation guard で扱う。
 * Nuxt は page component そのものを cache しない(Suspense/RouteProvider の vnode を cache する)ので、
 * page 側の onActivated/onDeactivated は呼ばれない(Vue の KeepAlive は cache された instance の
 * hook しか invoke しない)。また route の reactive な path は DOM の差し替え後に変わるため
 * 去る時の scrollY を正確に取れない。beforeEach(まだ一覧が DOM にある)で覚え、
 * afterEach(再attach 済み)で戻す。
 */
if (import.meta.client) {
  const router = useRouter()
  const offLeave = router.beforeEach((to, from) => {
    if (from.path !== '/items' || to.path === '/items') return
    // 一覧を去る: 追記を止め、スクロール位置を覚え、入力の確定待ちを確定させる
    // (戻ったとき一覧の条件が入力欄とズレない)
    pageActive = false
    savedScrollY = window.scrollY
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
      applyFilters()
    }
  })
  const offBack = router.afterEach(async (to, from) => {
    if (to.path !== '/items' || from.path === '/items') return
    // 一覧に戻る: 表示中にしてから、去った時の位置へスクロールを戻し、追記を続ける。
    // cached DOM の再attach は route 確定後の render で完了する(先に読むと高さが0でスクロールできない)
    pageActive = true
    await nextTick()
    if (savedScrollY) window.scrollTo(0, savedScrollY)
    // 復帰した位置に sentinel がまだ見えていれば追記を続ける(IO は再attach でも回调するが、
    // 回调を待たずにここで補う。loading/done の旗があるので重複はしない)。
    if (ioSupported.value) void loadMore()
  })
  onBeforeUnmount(() => {
    offLeave()
    offBack()
  })
}

// 解決は client のマウントで走る(SSR は端末の storage を読めないため空で描画し、マウント後に
// 端末ミラーから一覧・年組の選択肢・項目キーを埋める)。未取り込みの端末には案内カードを出す。
</script>

<template>
  <div class="page">
    <h1>レコード一覧</h1>

    <!-- 端末ミラーが無い端末: 一覧・選択肢・項目はすべて端末内のデータから出すので、取り込みを案内する -->
    <div v-if="mirrorStatus === 'missing'" class="card">
      <p class="muted">
        この端末に取り込み済みのデータがありません。「データの設定」(/sync)でデータセットを選んで「このスマホに取り込む」を実行してください(一覧・年組の選択肢・項目の選択肢は端末内のデータから出します)。
      </p>
    </div>

    <div class="card">
      <div class="search-row">
        <ClearableInput v-model="codeInput" label="code(部分一致)" placeholder="コードの一部を入力" />
        <ClearableInput v-model="nameInput" label="氏名(部分一致)" placeholder="氏名の一部を入力" />

        <!-- 折りたたみ欄のトグル(年・組 / 備考)。ラベルは短くして2つのトグルが1行に並ぶようにする(閉じた時の条件領域は1行のまま)。
            閉じていても選択状態はラベルに出て、開閉の意味は aria-label で伝える -->
        <div class="filter-toggles">
          <button
            class="btn secondary facet-toggle"
            type="button"
            :aria-expanded="facetSectionOpen"
            aria-controls="facet-panel"
            aria-label="年・組の絞り込み欄を開閉"
            @click="facetSectionOpen = !facetSectionOpen"
          >
            年・組 <span class="muted">({{ facetSelectionSummary }})</span>
          </button>
          <button
            class="btn secondary remark-toggle"
            type="button"
            :aria-expanded="remarkSectionOpen"
            aria-controls="remark-panel"
            aria-label="備考の絞り込み欄を開閉"
            @click="remarkSectionOpen = !remarkSectionOpen"
          >
            備考 <span class="muted">({{ remarkSelectionSummary }})</span>
          </button>
          <button
            class="btn secondary key-toggle"
            type="button"
            :aria-expanded="keySectionOpen"
            aria-controls="key-panel"
            aria-label="項目(任意の payload キー)の絞り込み欄を開閉"
            @click="keySectionOpen = !keySectionOpen"
          >
            項目 <span class="muted">({{ keySelectionSummary }})</span>
          </button>
        </div>

        <!-- 年・組の欄は縦に場所を取る(年9×組5)ので折りたたみできる。閉じても選択状態はラベルに出す -->
        <div id="facet-panel" v-show="facetSectionOpen" class="facet-panel">
          <div class="mode-row" role="group" aria-label="年・組の絞り込み方法">
            <button
              class="btn secondary"
              type="button"
              :class="{ active: facetMode === 'single' }"
              :aria-pressed="facetMode === 'single'"
              @click="setMode('single')"
            >
              年・組を単独で
            </button>
            <button
              class="btn secondary"
              type="button"
              :class="{ active: facetMode === 'pair' }"
              :aria-pressed="facetMode === 'pair'"
              @click="setMode('pair')"
            >
              年と組の組み合わせ
            </button>
          </div>

          <template v-if="facetMode === 'single'">
            <FacetChipGroup
              label="年(複数選択でOR)"
              suffix="年"
              :options="facets?.years ?? []"
              :selected="years"
              :loading="!facets"
              @toggle="toggleYear"
            />
            <FacetChipGroup
              label="組(複数選択でOR)"
              suffix="組"
              :options="facets?.groups ?? []"
              :selected="groups"
              :loading="!facets"
              @toggle="toggleGroup"
            />
            <p class="muted hint">
              年と組はそれぞれ複数選択で OR、年と組の間は AND で絞り込みます(1年・2年 + 3組 は「1年3組 と 2年3組」)。
              年と組の対応(1年3組 + 2年1組)は単独選択では指定できません。
            </p>
          </template>

          <template v-else>
            <YearGroupMatrix
              :years="facets?.years ?? []"
              :groups="facets?.groups ?? []"
              :pair-counts="facets?.pairs ?? []"
              :selected="pairs"
              :loading="!facets"
              @toggle="togglePair"
            />
            <p class="muted hint">
              選んだマス(その年 + その組)だけを対象にします。マス同士は OR なので、1年3組 + 2年1組 のような対応を指定できます。
              <span v-if="facets && facets.missingPairs">
                年または組が空のレコードは {{ facets.missingPairs }} 件あり、組み合わせでは選べません(条件なしなら表示されます)。
              </span>
            </p>
          </template>

          <p class="muted hint">
            <span v-if="facetError">選択肢を読み出せませんでした({{ facetError }})</span>
            <span v-else>年・組の値は取り込み済みの全レコードから生成しています(現在の絞り込み結果には連動しません)</span>
          </p>
        </div>

        <!-- 備考の欄: 有無の3ボタン(1行に並ぶ) + 部分一致入力。閉じると状態はトグルのラベルに出る -->
        <div id="remark-panel" v-show="remarkSectionOpen" class="remark-panel">
          <div class="mode-row" role="group" aria-label="備考の有無">
            <button
              class="btn secondary"
              type="button"
              :class="{ active: remarkState === 'any' }"
              :aria-pressed="remarkState === 'any'"
              @click="setRemarkState('any')"
            >
              すべて
            </button>
            <button
              class="btn secondary"
              type="button"
              :class="{ active: remarkState === 'present' }"
              :aria-pressed="remarkState === 'present'"
              @click="setRemarkState('present')"
            >
              あり
            </button>
            <button
              class="btn secondary"
              type="button"
              :class="{ active: remarkState === 'absent' }"
              :aria-pressed="remarkState === 'absent'"
              @click="setRemarkState('absent')"
            >
              なし
            </button>
          </div>
          <ClearableInput v-model="remarkInput" label="備考(部分一致)" placeholder="備考の一部を入力" />
          <p class="muted hint">
            「あり」は備考が入っている行、「なし」は備考が空(未記入・空文字)の行です。条件なしは「すべて」で、有無と文字検索は code・氏名・年・組との AND で絞ります。
          </p>
        </div>

        <!-- 項目の欄: 任意の payload キー(ボランティア欄など同期で載る項目)ごとの有無ボタン + 値 chip + 部分一致1キー + 表示のみトグル -->
        <div id="key-panel" v-show="keySectionOpen" class="key-panel">
          <p v-if="keysError" class="muted hint">項目の一覧を読み出せませんでした({{ keysError }})</p>
          <template v-else>
            <div v-for="entry in genericKeys" :key="entry.key" class="key-row">
              <div class="key-head">
                <span class="key-label">
                  {{ entry.key }}<span v-if="entry.fromConfig && !entry.seenInData" class="muted">(同期待ち)</span>
                </span>
                <div class="mode-row">
                  <button
                    class="btn secondary"
                    type="button"
                    :class="{ active: keyPresence[entry.key] === 'present' }"
                    :aria-pressed="keyPresence[entry.key] === 'present'"
                    :disabled="!isFilterableKey(entry.key)"
                    @click="toggleKeyPresence(entry.key, 'present')"
                  >
                    あり<span class="muted">{{ entry.presentCount }}</span>
                  </button>
                  <button
                    class="btn secondary"
                    type="button"
                    :class="{ active: keyPresence[entry.key] === 'absent' }"
                    :aria-pressed="keyPresence[entry.key] === 'absent'"
                    :disabled="!isFilterableKey(entry.key)"
                    @click="toggleKeyPresence(entry.key, 'absent')"
                  >
                    なし<span class="muted">{{ entry.absentCount }}</span>
                  </button>
                </div>
              </div>
              <FacetChipGroup
                v-if="isFilterableKey(entry.key) && entry.options.length && entry.options.length <= KEY_CHIP_MAX"
                :label="`${entry.key}の値(複数選択でOR)`"
                :options="entry.options"
                :selected="keySelections[entry.key] ?? []"
                :loading="!keysState"
                @toggle="(value: string) => toggleKeyValue(entry.key, value)"
              />
              <p v-else-if="!isFilterableKey(entry.key)" class="muted hint">
                このキーは `"` を含むか長さ上限を超えており、絞り込みの条件にできません(条件の運搬は URL の `キー|モード|値` の spec 文字列なので、キー名に区切りや引用符が混ざると共有リンクで復元できません。行への表示のみ可能です)。
              </p>
              <p v-else-if="entry.options.length > KEY_CHIP_MAX" class="muted hint">
                値の選択肢が {{ entry.options.length }} 件あるため chip 選択はしません(下の部分一致で絞れます)。
              </p>
            </div>

            <!-- 部分一致: 対象キーを1つ選んで語で絞る(語は code・氏名と同じデバウンス、キーセレクトは即適用) -->
            <div class="contains-row">
              <label class="key-select-wrap">
                <span class="muted">部分一致する項目</span>
                <select
                  class="key-select"
                  :value="containsKey"
                  aria-label="部分一致検索する項目を選ぶ"
                  @change="selectContainsKey(($event.target as HTMLSelectElement).value)"
                >
                  <option value="">項目を選択</option>
                  <option
                    v-for="entry in genericKeys"
                    :key="entry.key"
                    :value="entry.key"
                    :disabled="!isFilterableKey(entry.key)"
                  >
                    {{ entry.key }}
                  </option>
                </select>
              </label>
              <ClearableInput v-model="containsInput" label="項目の部分一致(選択したキー)" placeholder="値の一部を入力" />
            </div>

            <!-- 表示のみ: 選んだキーの値を一覧行に追加する(絞り込み条件は変わらない。ローカル保存) -->
            <FacetChipGroup
              label="行に表示する項目(絞り込まず表示だけ)"
              :options="showKeyOptions"
              :selected="showKeys"
              :loading="!keysState"
              @toggle="toggleShowKey"
            />
            <p class="muted hint">
              あり=値が入っている行、なし=空・未記入(キー欠落・null・空文字)の行です。項目同士・備考・code・氏名・年・組との指定はすべて AND で絞ります。「行に表示する項目」は条件を変えず行に値を追加します(ローカルに保存され、リセットでは消えません)。
            </p>
          </template>
        </div>

        <button class="btn secondary" type="button" :disabled="!hasFilters" @click="resetFilters">
          条件をリセット
        </button>
      </div>
      <p class="muted status" aria-live="polite">
        <span v-if="mirrorStatus === 'pending'">この端末のデータを読み込んでいます…</span>
        <span v-else-if="pending">検索中…</span>
        <span v-else-if="loading">読み込み中…</span>
        <span v-else>{{ total }} 件中 {{ rows.length }} 件表示</span>
      </p>
      <p v-if="mirrorStatus === 'ready'" class="muted offline-note">
        この端末のデータ({{ offlineSnapshotLabel }})から一覧を表示しています。シートが正なので、取り込み後にシート側で変わった値は次の取り込みまで現れません。年・組・項目の選択肢もこの端末のデータから生成しています(取り込み時の定義に載る予定で、まだ出現していない項目は件数0で出ます)。
      </p>
      <p v-if="mirrorStatus === 'foreign'" class="error">
        この端末のデータは別の利用者が取り込んだものです(氏名・備考を含むため一覧には出しません)。この利用者として取り込みし直すか、「データの設定」(/sync)で端末のデータを削除してください。
      </p>
      <p v-if="mirrorStatus === 'uidPending'" class="muted offline-note">
        取り込み済みのデータがありますがログイン状態が解決できていないため、この画面では端末内のデータを使いません(ログインしてから開いてください)。
      </p>
    </div>

    <div v-if="errorMessage" class="error card">
      <p>{{ errorMessage }}</p>
      <!-- 開発者向けの素のメッセージ(サーバの message + リクエスト行 + 下情報)。
           通常は畳むので、運用者には上の案内だけ見える。dev のコンソールと突き合わせられる。 -->
      <details v-if="errorDetail" class="error-detail">
        <summary>詳細(開発者向け)</summary>
        <code class="error-raw">{{ errorDetail }}</code>
      </details>
    </div>

    <div class="card">
      <ul v-if="rows.length" class="item-list">
        <ItemRow v-for="item in rows" :key="item.code" :item="item" :extra-keys="showKeys" />
      </ul>
      <p v-else-if="loading || pending || mirrorStatus === 'pending'" class="muted">読み込み中…</p>
      <p v-else-if="mirrorStatus !== 'ready'" class="muted">この端末のデータから一覧を出していません(上の案内)</p>
      <p v-else-if="!errorMessage" class="muted">該当するレコードがありません。</p>

      <!-- 追記のトリガー(常に描画して observer の対象を固定する)。0件のとき「最後まで」は出さない -->
      <div ref="sentinel" class="sentinel">
        <span v-if="loading" class="muted">次のレコードを読み込み中…</span>
        <span v-else-if="done && rows.length" class="muted">最後まで表示しました</span>
        <button
          v-else-if="!ioSupported"
          class="btn secondary"
          type="button"
          @click="load({ reset: false })"
        >
          次の {{ ITEM_PAGE_SIZE }} 件を表示
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* エラーの案内カード: 本文はユーザ向け文言、下は開発者向けの素のメッセージ(折りたたみ) */
.error-detail {
  margin-top: 8px;
}

.error-detail summary {
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
}

.error-raw {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted);
  word-break: break-word;
  white-space: pre-wrap;
}

.search-row {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 折りたたみ欄のトグル(年・組 / 備考)。狭い画面では折り返すが、閉じた状態では1行のボタンだけ */
.filter-toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.facet-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.remark-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 項目の欄: キーごとに「ラベル+有無ボタン」の行と値 chip。閉じるとトグル1行だけなので条件領域は普段増えない */
.key-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.key-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.key-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.key-label {
  font-size: 14px;
  font-weight: 600;
  word-break: break-word;
}

.mode-row .btn span.muted {
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
}

/* 部分一致の対象キーセレクト(ClearableInput と同じ縦積みのラベル付き欄) */
.contains-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}

.key-select-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.key-select {
  background: #122033;
  border: 1px solid var(--muted);
  border-radius: 8px;
  color: var(--text);
  font-size: 14px;
  padding: 10px 12px;
}

.mode-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.mode-row .btn {
  font-size: 14px;
  padding: 8px 12px;
}

.mode-row .btn.active {
  box-shadow: inset 0 0 0 2px rgba(120, 190, 255, 0.8);
}

/* 閉じた時のトグル3個(年・組/備考/項目)は mobile の1行に収める(ラベルは短い状態語だけ。padding を削って326px欄に316pxで収まる) */
.facet-toggle,
.remark-toggle,
.key-toggle {
  font-size: 14px;
  padding: 8px 10px;
}

.hint {
  margin: 0;
}

.status {
  margin: 10px 0 0;
}

.offline-note {
  margin: 6px 0 0;
  font-size: 12px;
}

.item-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.sentinel {
  padding-top: 12px;
  min-height: 24px;
}
</style>
