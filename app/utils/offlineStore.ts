/**
 * データセットの端末内保存(IndexedDB + localStorage)。client からのみ使う。
 * SSR では呼ばない(画面側は onMounted / client イベントからののみ呼び出す。
 * モジュール import 自体は storage を触らないので SSR バンドルに混ざっても安全)。
 *
 * - snapshot ストア: 1行(key='meta')の OfflineMeta(取り込み日時・件数・ソース定義・scan-config スナップショット)。
 *   **「今作業しているデータセット」は 1つだけ**(取り込み時に items を全消しして置き換える)。
 *   定義(public.sync_sources)は複数保持でき、そのから 1つを選んで取り込む。
 * - items ストア: `sourceId|code` → 行(取り込み応答の rows をそのまま。別のシートの同じ code は別人なので複合キー)。
 * - queue ストア: 記録の待機(entry.id → OfflineQueueEntry)。画面を閉じても残る。任意のタイミングで確定する。
 * - **端末の個人データの削除**: `purgeDeviceData()`(ミラー + localStorage のメタ/選択 + SW のページキャッシュを消し、
 *   ためた記録は氏名だけ除去して残す)。ログアウト(`app/composables/useLogout.ts`)と管理欄の削除ボタンが呼ぶ。
 * - ミラーは**取り込んだ利用者の uid** をメタに持つ(`OfflineMeta.uid`)。別ユーザのログインでは
 *   `mirrorBelongsToUser` の判定でローカル作業が使えない(端末の氏名を別ユーザに読ませない)。
 */
import {
  ACTIVE_SOURCE_STORAGE_KEY,
  datasetKey,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_ITEMS_STORE,
  OFFLINE_META_STORAGE_KEY,
  OFFLINE_PAGE_CACHE_NAME,
  OFFLINE_QUEUE_STORE,
  OFFLINE_SNAPSHOT_KEY,
  OFFLINE_SNAPSHOT_STORE,
  parseActiveSource,
  parseOfflineMeta,
  serializeActiveSource,
  serializeOfflineMeta,
  type OfflineMeta,
  type OfflineQueueEntry,
} from '#shared/utils/offline'

/**
 * 端末ミラーの1行。payload は取り込み定義の選別・rename 適用後のキーで**文字列のみ**
 * (`/api/import` の rows = `SyncRow` そのまま。merge/set も文字列しか写さない)。
 * `ItemRowData`(payload: Record<string, unknown>)の部分型なので shared の照合関数にそのまま渡せる。
 */
export interface OfflineItemRow {
  code: string
  /** この行がどのデータセットの行か(items ストアは複数データセットが住むので行自身に載せる) */
  sourceId: number
  payload: Record<string, string>
}

function openOfflineDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(OFFLINE_SNAPSHOT_STORE)) db.createObjectStore(OFFLINE_SNAPSHOT_STORE)
      if (!db.objectStoreNames.contains(OFFLINE_ITEMS_STORE)) db.createObjectStore(OFFLINE_ITEMS_STORE)
      if (!db.objectStoreNames.contains(OFFLINE_QUEUE_STORE)) db.createObjectStore(OFFLINE_QUEUE_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

/** 1トランザクションで複数 store をまとめて clear/put/delete し、oncomplete で解決する(全件取り込みを1txで行う)。 */
async function offlineReadWrite(stores: string[], use: (tx: IDBTransaction) => void): Promise<void> {
  const db = await openOfflineDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite')
      use(tx)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    })
  } finally {
    db.close()
  }
}

function offlineRead<T>(store: string, use: (objectStore: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openOfflineDb().then((db) => {
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly')
      const req = use(tx.objectStore(store))
      req.onsuccess = () => resolve(req.result)
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB read failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB read aborted'))
    }).finally(() => db.close())
  })
}

/**
 * 取り込み: ミラーを**そのデータセットで置き換える**(items を全消し→ rows を put、meta を書き込む)。
 * データセットの切替も同じ関数(前のデータセットの行は消える = 「今どちらのデータで作業するか」は1つ)。
 *
 * meta / rows は画面側の reactive なオブジェクト(Vue の Proxy)をそのまま渡すことがある。
 * Proxy は IndexedDB の structured clone で `DataCloneError` になる(dev の取り込みで実測:
 * 「Failed to execute 'put' on 'IDBObjectStore': #<Object> could not be cloned」)。
 * 値は文字列・数値・配列のみなので JSON の往復で**素のオブジェクト**にしてから書く。
 */
export async function offlineSaveSnapshot(meta: OfflineMeta, rows: OfflineItemRow[]): Promise<void> {
  const plainMeta = JSON.parse(JSON.stringify(meta)) as OfflineMeta
  const plainRows = JSON.parse(JSON.stringify(rows)) as OfflineItemRow[]
  await offlineReadWrite([OFFLINE_ITEMS_STORE, OFFLINE_SNAPSHOT_STORE], (tx) => {
    tx.objectStore(OFFLINE_ITEMS_STORE).clear()
    for (const row of plainRows) tx.objectStore(OFFLINE_ITEMS_STORE).put(row, datasetKey(plainMeta.sourceId, row.code))
    tx.objectStore(OFFLINE_SNAPSHOT_STORE).put(plainMeta, OFFLINE_SNAPSHOT_KEY)
  })
}

/** 照会・check: そのデータセットの code の行を引く(見つからなければ undefined)。 */
export async function offlineGetItem(sourceId: number, code: string): Promise<OfflineItemRow | undefined> {
  const row = await offlineRead<OfflineItemRow | undefined>(
    OFFLINE_ITEMS_STORE,
    (s) => s.get(datasetKey(sourceId, code)) as IDBRequest<OfflineItemRow | undefined>,
  )
  return row ?? undefined
}

/** 一覧・facets・項目キー: そのデータセットの全行。IDB の key は文字列順なので照合側(offlineItemsQuery)で数値順に並び直す。 */
export async function offlineGetAllItems(sourceId: number): Promise<OfflineItemRow[]> {
  const rows = await offlineRead<OfflineItemRow[]>(OFFLINE_ITEMS_STORE, (s) => s.getAll() as IDBRequest<OfflineItemRow[]>)
  return (rows ?? []).filter((row) => row && row.sourceId === sourceId)
}

/**
 * flush の書き込み値をミラーに反映する(シートが正。端末の一覧・照会が即時に追随する)。
 * 空値は載せない(mapSheetRows の「空値は payload に載せない」と同じ基準)。
 * 行が無い code(シートにまだ無い行)は何もしない(次の取り込みで現れる)。
 */
export async function offlineMergePayload(sourceId: number, code: string, written: Record<string, string>): Promise<void> {
  const row = await offlineGetItem(sourceId, code)
  if (!row) return
  const payload = { ...row.payload }
  for (const [key, value] of Object.entries(written)) {
    if (value === '' || value === undefined) continue
    payload[key] = value
  }
  await offlineReadWrite([OFFLINE_ITEMS_STORE], (tx) => {
    tx.objectStore(OFFLINE_ITEMS_STORE).put({ ...row, payload }, datasetKey(sourceId, code))
  })
}

/**
 * ミラーの payload の1キーを確定値に書き換える(備考の編集用。空値はキーを**削除**する)。
 * offlineMergePayload と違い空値を「消す」として扱う(取り込み側の empty skip と同じ挙動 = 備考の有無絞り込みが追随する)。
 * 行が無い code は何もしない(シートにまだ無い行 = 次の取り込みで現れる)。
 */
export async function offlineSetPayloadKey(sourceId: number, code: string, key: string, value: string): Promise<void> {
  const row = await offlineGetItem(sourceId, code)
  if (!row) return
  const payload = { ...row.payload }
  if (value) payload[key] = value
  else delete payload[key]
  await offlineReadWrite([OFFLINE_ITEMS_STORE], (tx) => {
    tx.objectStore(OFFLINE_ITEMS_STORE).put({ ...row, payload }, datasetKey(sourceId, code))
  })
}

/** 取り込み時のメタ(IDB 側。localStorage フラグが壊れていても config・ソース定義を引き直す)。 */
export async function offlineReadMeta(): Promise<OfflineMeta | null> {
  const meta = await offlineRead<OfflineMeta | null>(OFFLINE_SNAPSHOT_STORE, (s) => s.get(OFFLINE_SNAPSHOT_KEY) as IDBRequest<OfflineMeta | null>)
  return meta ?? null
}

/** ミラー削除(items と meta)。記録のキューは確定できるため残す(別データセットの待機も消さない)。 */
export async function offlineDeleteSnapshot(): Promise<void> {
  await offlineReadWrite([OFFLINE_ITEMS_STORE, OFFLINE_SNAPSHOT_STORE], (tx) => {
    tx.objectStore(OFFLINE_ITEMS_STORE).clear()
    tx.objectStore(OFFLINE_SNAPSHOT_STORE).delete(OFFLINE_SNAPSHOT_KEY)
  })
}

/**
 * 記録の待機キューの**氏名だけ**除去する。ミラー削除・ログアウト後も「ためた記録」は確定できる設計なので
 * 記録そのものは残し、端末に氏名を置かないために name を null に書き換える
 * (確定に必要な入力は modeId / code / at / overwrite のみ = `normalizeOfflineEntries` が捨てる項目と同じ)。
 * 返り値は書き換えた件数。
 */
export async function offlineStripQueueNames(): Promise<number> {
  const rows = await offlineRead<OfflineQueueEntry[]>(
    OFFLINE_QUEUE_STORE,
    (s) => s.getAll() as IDBRequest<OfflineQueueEntry[]>,
  )
  const named = (rows ?? []).filter((e) => e && typeof e.name === 'string' && e.name !== '')
  if (named.length === 0) return 0
  await offlineReadWrite([OFFLINE_QUEUE_STORE], (tx) => {
    for (const e of named) tx.objectStore(OFFLINE_QUEUE_STORE).put({ ...e, name: null }, e.id)
  })
  return named.length
}

/** ためた記録の待機をすべて捨てる(未確定の記録はシートに書かれないまま消える。明示の「すべて捨てる」だけで使う)。 */
export async function offlineClearQueue(): Promise<void> {
  await offlineReadWrite([OFFLINE_QUEUE_STORE], (tx) => {
    tx.objectStore(OFFLINE_QUEUE_STORE).clear()
  })
}

/**
 * SW のページキャッシュを捨てる(`OFFLINE_PAGE_CACHE_NAME`)。
 * 缓存された SSR HTML には氏名・備考(/items の1ページ目)と email(/ のログイン状態)が載るため、
 * 端末データの削除では IndexedDB と一緒に消す。SW が無い環境(dev)は何もしない。
 */
export async function offlineClearPageCache(): Promise<void> {
  if (typeof caches === 'undefined') return
  try {
    await caches.delete(OFFLINE_PAGE_CACHE_NAME)
  } catch {
    // 削除失敗は端末ストレージ側の失敗として扱う(IDB の削除は完了している)
  }
}

/** 記録の1読み取りをキューにためる(任意のタイミングで確定する)。 */
export async function offlineAddQueueEntry(entry: OfflineQueueEntry): Promise<void> {
  await offlineReadWrite([OFFLINE_QUEUE_STORE], (tx) => {
    tx.objectStore(OFFLINE_QUEUE_STORE).put(entry, entry.id)
  })
}

export async function offlineListQueue(): Promise<OfflineQueueEntry[]> {
  const rows = await offlineRead<OfflineQueueEntry[]>(OFFLINE_QUEUE_STORE, (s) => s.getAll() as IDBRequest<OfflineQueueEntry[]>)
  return rows ?? []
}

export async function offlineQueueCount(): Promise<number> {
  const n = await offlineRead<number>(OFFLINE_QUEUE_STORE, (s) => s.count())
  return n ?? 0
}

/** 確定済み(または上書き解決済み)の entry をキューから除く。write_failed は送らない(再確定のために残す)。 */
export async function offlineRemoveQueueEntries(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await offlineReadWrite([OFFLINE_QUEUE_STORE], (tx) => {
    for (const id of ids) tx.objectStore(OFFLINE_QUEUE_STORE).delete(id)
  })
}

// ── localStorage の有効化フラグ+メタ(SSR では読めない。画面側は onMounted で引き当てる)──

/** localStorage のメタを読む。非 client・破損・非 JSON・旧形(sourceId 無し)は null(無効扱い)。 */
export function readOfflineMetaFromStorage(): OfflineMeta | null {
  if (typeof localStorage === 'undefined') return null
  try {
    return parseOfflineMeta(localStorage.getItem(OFFLINE_META_STORAGE_KEY))
  } catch {
    return null
  }
}

export function writeOfflineMetaToStorage(meta: OfflineMeta): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(OFFLINE_META_STORAGE_KEY, serializeOfflineMeta(meta))
}

export function clearOfflineMetaStorage(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(OFFLINE_META_STORAGE_KEY)
}

/** 作業中のデータセットの id localStorage 往復(取り込みの有無と独立。ページ間で共有する)。 */
export function readActiveSourceFromStorage(): number | null {
  if (typeof localStorage === 'undefined') return null
  try {
    return parseActiveSource(localStorage.getItem(ACTIVE_SOURCE_STORAGE_KEY))
  } catch {
    return null
  }
}

export function writeActiveSourceToStorage(sourceId: number): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(ACTIVE_SOURCE_STORAGE_KEY, serializeActiveSource(sourceId))
}

/** 記録の待機が「今作業しているデータセット」由来かどうか(復旧確定の案内用)。 */
export function queueEntriesForSource(entries: OfflineQueueEntry[], sourceId: number): OfflineQueueEntry[] {
  return entries.filter((e) => e.sourceId === sourceId)
}

/** 「作業中のデータセット」の選択(localStorage)を消す(端末データの削除でミラーと一緒に捨てる)。 */
export function clearActiveSourceStorage(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(ACTIVE_SOURCE_STORAGE_KEY)
}

/**
 * **1データセットの端末コピーだけを捨てる**(0011 の中央消去指示の apply。`useDevicePurge` が呼ぶ)。
 * - items からその sourceId の行を消す(他データセットの行は温存)
 * - メタがそのデータセットなら snapshot と localStorage のメタを消す(別のデータセットのメタは温存)
 * - その source の queue entry は**氏名だけ除去**して code / modeId / at を残す(記録は確定できる)
 * - 「作業中のデータセット」選択がその sourceId なら消す
 * - SW のページ缓存は全体を消す(缓存 HTML に氏名が載る。データセット単位で缓存を分けないので保守側)
 */
export async function offlinePurgeSource(sourceId: number): Promise<{ purgedRows: number; strippedNames: number }> {
  const rows = await offlineGetAllItems(sourceId)
  const meta = await offlineReadMeta()
  const queue = await offlineListQueue()
  const named = queue.filter((e) => e && e.sourceId === sourceId && typeof e.name === 'string' && e.name !== '')
  await offlineReadWrite([OFFLINE_ITEMS_STORE, OFFLINE_SNAPSHOT_STORE, OFFLINE_QUEUE_STORE], (tx) => {
    const items = tx.objectStore(OFFLINE_ITEMS_STORE)
    for (const row of rows) items.delete(datasetKey(sourceId, row.code))
    if (meta && meta.sourceId === sourceId) tx.objectStore(OFFLINE_SNAPSHOT_STORE).delete(OFFLINE_SNAPSHOT_KEY)
    const q = tx.objectStore(OFFLINE_QUEUE_STORE)
    for (const e of named) q.put({ ...e, name: null }, e.id)
  })
  if (meta && meta.sourceId === sourceId) clearOfflineMetaStorage()
  if (readActiveSourceFromStorage() === sourceId) clearActiveSourceStorage()
  await offlineClearPageCache()
  return { purgedRows: rows.length, strippedNames: named.length }
}

/**
 * **この端末の個人データをまとめて捨てる**(ログアウトと「端末のデータを完全に削除」で呼ぶ)。
 * - `items` / `snapshot` のミラー(氏名・備考・任意 payload を含む)を消す
 * - localStorage のメタ(`hinotike-offline-meta`)と「作業中のデータセット」(`hinotike-active-source`)を消す
 * - SW のページキャッシュ(`hinotike-pages`)を消す(缓存 HTML に氏名・email が載る)
 * - ためた記録の待機は**氏名だけ除去**して code / modeId / at を残す(未確定の記録は捨てず、通信が戻れば確定できる)
 * 表示設定(`items-show-keys` / `qr-scan-mode` / 静音フラグ)は個人情報ではないので残す。
 */
export async function purgeDeviceData(): Promise<{ strippedNames: number; queueKept: number }> {
  await offlineDeleteSnapshot()
  const strippedNames = await offlineStripQueueNames()
  clearOfflineMetaStorage()
  clearActiveSourceStorage()
  await offlineClearPageCache()
  return { strippedNames, queueKept: await offlineQueueCount() }
}
