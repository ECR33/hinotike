import {
  clampHistoryLimit,
  historyNextCursor,
  type ScanHistoryResponse,
  type ScanHistoryRow,
  type ScanStatus,
} from '#shared/utils/scan'

/** 記録の status 参数をホワイトリストで受け取る(認識しない値は条件なし)。 */
function normalizeStatus(raw: unknown): ScanStatus | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  const allowed: ScanStatus[] = ['ok', 'duplicate', 'not_found', 'sheet_missing', 'write_failed', 'skipped']
  return allowed.includes(value as ScanStatus) ? (value as ScanStatus) : null
}

/** 日付参数を ISO に(画面は JST の datetime-local を送る。'Z' が無いものは JST 時刻として扱う)。 */
function toIso(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.endsWith('Z')) return trimmed
  // 画面が JST の wall clock を送るため +09:00 を補う(UTC wall clock と混ざらないように明示)
  const iso = trimmed.includes('T') ? `${trimmed}+09:00` : trimmed
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString()
}

/**
 * 記録履歴(scan_events)のページ付き一覧。登録済みユーザのみ(監査目的の閲覧)。
 *
 * 分页は seq(挿入順の bigserial)降順のキーセットカーソル: `seq < cursor` を次ページとして読む。
 * uuid は time-order ではないので「新しい順」のカーソルには使えない(seq が正)。
 * 絞り込みは mode_name / code / status / at の期間(すべて AND)。
 * 応答の rows.at は ISO(DB 保存)。JST 表記は画面側(shared/utils/scan.ts の formatJst)で出す。
 * total は exact count(一致総件数。監査の「この期間の読み取り件数」表示用)。
 */
export default defineEventHandler(async (event): Promise<ScanHistoryResponse> => {
  const { supabase } = await requireRegisteredUser(event)

  const query = getQuery(event)
  const mode = typeof query.mode === 'string' ? query.mode.trim() : ''
  const code = typeof query.code === 'string' ? query.code.trim() : ''
  const status = normalizeStatus(query.status)
  const from = toIso(query.from)
  const to = toIso(query.to)
  const cursor = typeof query.cursor === 'string' ? Number(query.cursor) : Number.NaN
  const limit = clampHistoryLimit(query.limit)

  let builder = supabase
    .from('scan_events')
    .select('seq, code, mode_name, name, actor_email, status, written, sheet_range, at', { count: 'exact' })
    .order('seq', { ascending: false })
    .limit(limit)

  if (mode) builder = builder.eq('mode_name', mode)
  if (code) builder = builder.eq('code', code)
  if (status) builder = builder.eq('status', status)
  if (from) builder = builder.gte('at', from)
  if (to) builder = builder.lte('at', to)
  if (Number.isInteger(cursor) && cursor > 0) builder = builder.lt('seq', cursor)

  const { data, count, error } = await builder
  if (error) {
    console.error('[scan-history] scan_events:', error.message)
    throw createError({ statusCode: 500, statusMessage: 'scan_events list failed' })
  }

  const rows: ScanHistoryRow[] = (data ?? []).map((row) => {
    const r = row as Record<string, unknown>
    return {
      seq: typeof r.seq === 'number' ? r.seq : 0,
      code: String(r.code ?? ''),
      modeName: String(r.mode_name ?? ''),
      name: typeof r.name === 'string' ? r.name : null,
      actorEmail: typeof r.actor_email === 'string' ? r.actor_email : null,
      status: (typeof r.status === 'string' ? r.status : 'ok') as ScanStatus,
      written: (r.written ?? {}) as Record<string, string>,
      sheetRange: typeof r.sheet_range === 'string' ? r.sheet_range : null,
      at: typeof r.at === 'string' ? r.at : '',
    }
  })

  return {
    rows,
    nextCursor: historyNextCursor(rows, limit),
    total: count ?? rows.length,
  }
})
