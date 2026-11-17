/**
 * オフラインモードのローカル保存(IndexedDB + localStorage)。client からのみ使う。
 * SSR では呼ばない(画面側は onMounted / client イベントからののみ呼び出す。
 * モジュール import 自体は storage を触らないので SSR バンドルに混ざっても安全)。
 *
 * - snapshot ストア: 1行(key='meta')の OfflineMeta(準備日時・件数・scan-config スナップショット)。
 * - items ストア: code → items 行(items-list の rows をそのまま。照会結果画面は imported_at も使う)。
 * - queue ストア: オフライン記録の待機(entry.id → OfflineQueueEntry)。画面を閉じても残る。
 */
import {
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_ITEMS_STORE,
  OFFLINE_META_STORAGE_KEY,
  OFFLINE_QUEUE_STORE,
  OFFLINE_SNAPSHOT_KEY,
  OFFLINE_SNAPSHOT_STORE,
  parseOfflineMeta,
  serializeOfflineMeta,
  type OfflineMeta,
  type OfflineQueueEntry,
} from '#shared/utils/offline'
import type { ItemRowData } from '#shared/utils/items'

/** items スナップショットの行(items-list が select '*' で返す行そのまま。result 画面は imported_at を詳細に出す)。 */
export interface OfflineItemRow extends ItemRowData {
  imported_at?: string | null
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

/** 1トランザクションで複数 store をまとめて clear/put/delete し、oncomplete で解決する(全件ダウンロードを1txで行う)。 */
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

/** 準備: スナップショットを保存(items を全消し→全件 put、meta を書き込む)。 */
export async function offlineSaveSnapshot(meta: OfflineMeta, rows: OfflineItemRow[]): Promise<void> {
  await offlineReadWrite([OFFLINE_ITEMS_STORE, OFFLINE_SNAPSHOT_STORE], (tx) => {
    tx.objectStore(OFFLINE_ITEMS_STORE).clear()
    for (const row of rows) tx.objectStore(OFFLINE_ITEMS_STORE).put(row, row.code)
    tx.objectStore(OFFLINE_SNAPSHOT_STORE).put(meta, OFFLINE_SNAPSHOT_KEY)
  })
}

/** オフライン照会・check: code の行を引く(見つからなければ undefined)。 */
export async function offlineGetItem(code: string): Promise<OfflineItemRow | undefined> {
  const row = await offlineRead<OfflineItemRow | undefined>(OFFLINE_ITEMS_STORE, (s) => s.get(code) as IDBRequest<OfflineItemRow | undefined>)
  return row ?? undefined
}

/** オフライン一覧(/items): items 全件。IDB の key は文字列順なので照合側(offlineItemsQuery)で数値順に並び直す。 */
export async function offlineGetAllItems(): Promise<OfflineItemRow[]> {
  const rows = await offlineRead<OfflineItemRow[]>(OFFLINE_ITEMS_STORE, (s) => s.getAll() as IDBRequest<OfflineItemRow[]>)
  return rows ?? []
}

/** 準備時のメタ(IDB 側。localStorage フラグが壊れていても config を引き直す)。 */
export async function offlineReadMeta(): Promise<OfflineMeta | null> {
  const meta = await offlineRead<OfflineMeta | null>(OFFLINE_SNAPSHOT_STORE, (s) => s.get(OFFLINE_SNAPSHOT_KEY) as IDBRequest<OfflineMeta | null>)
  return meta ?? null
}

/** スナップショット削除(items と meta)。オフライン記録のキューは復旧確定できるため残す。 */
export async function offlineDeleteSnapshot(): Promise<void> {
  await offlineReadWrite([OFFLINE_ITEMS_STORE, OFFLINE_SNAPSHOT_STORE], (tx) => {
    tx.objectStore(OFFLINE_ITEMS_STORE).clear()
    tx.objectStore(OFFLINE_SNAPSHOT_STORE).delete(OFFLINE_SNAPSHOT_KEY)
  })
}

/** オフライン記録の1読み取りをキューにためる(復旧後にフラッシュする)。 */
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

/** localStorage のメタを読む。非 client・破損・非 JSON は null(無効扱い)。 */
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
