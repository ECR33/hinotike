import {
  ITEM_FACET_SCAN_LIMIT,
  facetCounts,
  type ItemKeyEntry,
  type ItemsKeysResponse,
} from '#shared/utils/items'
import { settingsFromDb } from '#shared/utils/sync'

/**
 * 一覧の「任意項目」絞り込み・表示のための**payload キーの発見**。
 *
 * 前提: Google 認証済み + users テーブルへの紐付け(items-list / items-facets と同じ requireRegisteredUser。
 * sync_settings は RLS の sync_settings_select_registered で読む)。
 *
 * 項目(キー)は同期設定(includeColumns + rename)とシートヘッダー由来の任意文字列で、
 * 静的な一覧では決められない。2つの源の和集合を返す:
 *  - **設定から**: includeColumns を rename 適用後のキーに写した「載る予定のキー」
 *    (includeColumns が空のときは rename の新キー名だけ。全カラム取り込みでは未知キーは実データ側で出る)。
 *  - **実データから**: items の payload をスキャン(ITEM_FACET_SCAN_LIMIT 上限)して実際に出現したキー。
 * キーごとにあり/なしの件数(あり = 値が null でなく空文字でない。なし = 欠落・null・空文字。
 * items-list の present/absent と同じ意味)と値の選択肢(options。facetCounts と同じ trim・昇順)を出す。
 * 設定に載る予定だがまだ行に出現していないキーは seenInData=false で出す(同期待ち。UI は消さずに注記する)。
 * codeColumn は payload に載らないので候補から除く。
 */
export default defineEventHandler(async (event): Promise<ItemsKeysResponse> => {
  const { supabase } = await requireRegisteredUser(event)

  const [settingsRes, rowsRes] = await Promise.all([
    supabase.from('sync_settings').select('*').limit(1),
    supabase.from('items').select('payload').limit(ITEM_FACET_SCAN_LIMIT),
  ])

  if (settingsRes.error) {
    console.error('[items-keys] sync_settings:', settingsRes.error.message)
    throw createError({ statusCode: 500, statusMessage: 'items keys failed' })
  }
  if (rowsRes.error) {
    console.error('[items-keys] items:', rowsRes.error.message)
    throw createError({ statusCode: 500, statusMessage: 'items keys failed' })
  }

  const settings = settingsFromDb(settingsRes.data?.[0] as Record<string, unknown> | undefined)
  const candidates = new Set<string>()
  if (settings.includeColumns.length > 0) {
    for (const col of settings.includeColumns) {
      if (col === settings.codeColumn) continue
      candidates.add(settings.rename[col] ?? col)
    }
  } else {
    // 全カラム取り込みではシートヘッダーが DB から分からない。rename の新キー名だけを「載る予定」とする
    for (const to of Object.values(settings.rename)) candidates.add(to)
  }

  const scanned = (rowsRes.data ?? []) as { payload: Record<string, unknown> | null }[]
  const present = new Map<string, number>()
  const seen = new Set<string>()
  const values = new Map<string, (string | null | undefined)[]>()
  for (const row of scanned) {
    const payload = row.payload ?? {}
    for (const [key, value] of Object.entries(payload)) {
      // キー名は切り捨てずそのまま返す(長いキーや `"` を含むキーは UI/API 側で isFilterableKey=false → 表示のみ)
      seen.add(key)
      const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)
      // items-list の present と同じ判定(空文字・欠落は absent 側。空白のみの値は present 側で options から出る)
      if (text !== '') {
        present.set(key, (present.get(key) ?? 0) + 1)
        values.set(key, [...(values.get(key) ?? []), text])
      }
    }
  }

  // 2つの源の和集合。`[...candidates, ...seen]` の連結は両方に載るキーを2回出すので Set で除重する
  const union = new Set<string>([...candidates, ...seen])
  const keys: ItemKeyEntry[] = []
  for (const key of union) {
    const presentCount = present.get(key) ?? 0
    keys.push({
      key,
      presentCount,
      absentCount: scanned.length - presentCount,
      options: facetCounts(values.get(key) ?? []),
      fromConfig: candidates.has(key),
      seenInData: seen.has(key),
    })
  }
  keys.sort((a, b) => a.key.localeCompare(b.key, 'ja'))

  return {
    keys,
    scanned: scanned.length,
    truncated: scanned.length >= ITEM_FACET_SCAN_LIMIT,
  }
})
