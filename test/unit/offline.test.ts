/**
 * ローカルデータセットの共通ロジック(shared/utils/offline.ts)の単体テスト。
 * IndexedDB / localStorage の実装(app/utils/offlineStore.ts)は client ののみなのでここでは叩かない。
 */
import { describe, expect, it } from 'vitest'
import {
  datasetKey,
  localWorkAllowed,
  makeOfflineQueueId,
  mirrorBelongsToUser,
  normalizeOfflineEntries,
  offlineFacets,
  offlineItemsQuery,
  offlineKeys,
  offlineScanCheckResponse,
  parseOfflineMeta,
  serializeOfflineMeta,
  type OfflineMeta,
} from '../../shared/utils/offline'
import { SCAN_CODE_MAX_LENGTH, normalizeScanModes, stateOfPayload, type ScanConfigResponse, type ScanMode } from '../../shared/utils/scan'
import { DEFAULT_SOURCE, type SyncSource } from '../../shared/utils/sync'

const checkinMode: ScanMode = {
  id: 2,
  sourceId: 1,
  name: 'チェックイン',
  actions: [{ column: '来場済', columnAt: '来場日時', literal: '済', payloadKey: '来場済', payloadAtKey: '来場日時' }],
  dedupe: 'warn',
  confirmBeforeRecord: true,
  requireFound: true,
  enabled: true,
  updatedAt: null,
  updatedBy: null,
}

/** テスト用のデータセット定義(id 付きの 1行)。 */
const sourceA: SyncSource = { ...DEFAULT_SOURCE, id: 1, name: 'チケットA', spreadsheetId: '1Abc-def_1234567890' }

const baseConfig: ScanConfigResponse = {
  modes: [checkinMode],
  sources: [sourceA],
  serviceAccountConfigured: true,
  rowMissing: false,
  sourceMissing: false,
  sheetTitle: 'dev',
  sheetHeaders: ['code', '氏名', '来場済', '来場日時'],
}

const at = '2026-11-17T02:00:00.000Z'

/** ミラーメタのテスト用テンプレート(データセット付き)。 */
function metaOf(over: Partial<OfflineMeta> = {}): OfflineMeta {
  return {
    enabled: true,
    sourceId: 1,
    uid: 'uid-1',
    sourceName: 'チケットA',
    source: sourceA,
    snapshotAt: at,
    itemCount: 1234,
    config: baseConfig,
    capped: false,
    ...over,
  }
}

/** parseOfflineMeta が読む JSON を作るときに必須項目(sourceId/uid/source)を必ず载せる。 */
function metaJson(obj: Record<string, unknown>): string {
  return JSON.stringify({ sourceId: 1, uid: 'uid-1', sourceName: 'チケットA', source: sourceA, ...obj })
}

describe('parseOfflineMeta / serializeOfflineMeta', () => {
  it('serialize→parse で往復できる(データセットの id・定義も残る)', () => {
    const meta = metaOf()
    const parsed = parseOfflineMeta(serializeOfflineMeta(meta))
    expect(parsed).not.toBeNull()
    expect(parsed?.enabled).toBe(true)
    expect(parsed?.snapshotAt).toBe(at)
    expect(parsed?.itemCount).toBe(1234)
    expect(parsed?.sourceId).toBe(1)
    expect(parsed?.uid).toBe('uid-1')
    expect(parsed?.sourceName).toBe('チケットA')
    expect(parsed?.source.codeColumn).toBe('ID')
    expect(parsed?.config.modes[0]?.name).toBe('チェックイン')
    expect(parsed?.config.modes[0]?.sourceId).toBe(1)
    expect(parsed?.config.sources.map((s) => s.name)).toEqual(['チケットA'])
  })

  it('破損・空・非オブジェクトは null(無効扱い)', () => {
    expect(parseOfflineMeta(null)).toBeNull()
    expect(parseOfflineMeta('')).toBeNull()
    expect(parseOfflineMeta('zz')).toBeNull()
    expect(parseOfflineMeta('[]')).toBeNull()
    expect(parseOfflineMeta('{}')).toBeNull()
    // snapshotAt が日時として不正
    expect(parseOfflineMeta(metaJson({ enabled: true, snapshotAt: 'zz', itemCount: 1, config: { modes: [] } }))).toBeNull()
    // config.modes が配列でなければ null(モード選択が壊れたミラーを有効にしない)
    expect(parseOfflineMeta(metaJson({ enabled: true, snapshotAt: at, itemCount: 1, config: {} }))).toBeNull()
  })

  it('旧形(データセット前のスナップショット)は null = 再取り込みを促す', () => {
    expect(parseOfflineMeta(JSON.stringify({ enabled: true, snapshotAt: at, itemCount: 1, config: { modes: [] } }))).toBeNull()
    expect(parseOfflineMeta(metaJson({ enabled: true, snapshotAt: at, itemCount: 1, config: { modes: [] }, sourceId: 0 }))).toBeNull()
    expect(parseOfflineMeta(metaJson({ enabled: true, snapshotAt: at, itemCount: 1, config: { modes: [] }, sourceId: 'x' }))).toBeNull()
  })

  it('uid が無い・空・非文字列のメタは null(別ユーザが読めるミラーを有効にしない)', () => {
    const base = { enabled: true, snapshotAt: at, itemCount: 2, config: { modes: [] } }
    expect(parseOfflineMeta(JSON.stringify({ sourceId: 1, sourceName: 'チケットA', source: sourceA, ...base }))).toBeNull()
    expect(parseOfflineMeta(metaJson({ ...base, uid: '' }))).toBeNull()
    expect(parseOfflineMeta(metaJson({ ...base, uid: '   ' }))).toBeNull()
    expect(parseOfflineMeta(metaJson({ ...base, uid: 42 }))).toBeNull()
    expect(parseOfflineMeta(metaJson({ ...base, uid: 'uid-1' }))?.enabled).toBe(true)
    expect(parseOfflineMeta(metaJson({ ...base, uid: 'uid-1' }))?.uid).toBe('uid-1')
  })

  it('DB の snake_case actions も normalize で補われる(jsonb 由来の形そのままでも動く)', () => {
    const raw = metaJson({
      enabled: true,
      snapshotAt: at,
      itemCount: 2,
      config: {
        modes: [{ id: 3, source_id: 2, name: '棚卸し', actions: [{ column: '確認済', column_at: '確認日時', literal: '済', payload_key: '確認済', payload_at_key: '確認日時' }] }],
        sources: [{ id: 2, name: 'チケットB' }],
        rowMissing: false,
      },
    })
    const parsed = parseOfflineMeta(raw)
    expect(parsed?.config.modes[0]?.actions[0]?.payloadAtKey).toBe('確認日時')
    expect(parsed?.config.modes[0]?.sourceId).toBe(2)
    expect(parsed?.config.sources[0]?.name).toBe('チケットB')
    expect(parsed?.config.sheetTitle).toBeNull()
    expect(parsed?.config.sheetHeaders).toBeNull()
  })

  it('enabled: false は valid なメタとして通る(解除 = フラグ false でデータ残)', () => {
    const raw = metaJson({ enabled: false, snapshotAt: at, itemCount: 5, config: { modes: [] } })
    expect(parseOfflineMeta(raw)?.enabled).toBe(false)
    expect(parseOfflineMeta(raw)?.sourceId).toBe(1)
  })
})

describe('datasetKey(複数データセットを同じストアに住ませる)', () => {
  it('sourceId|code の複合キー(別シートの同じ code が別人を指すので code 単独は使えない)', () => {
    expect(datasetKey(1, '1001')).toBe('1|1001')
    expect(datasetKey(2, '1001')).toBe('2|1001')
    expect(datasetKey(1, '1001')).not.toBe(datasetKey(2, '1001'))
  })
})

describe('mirrorBelongsToUser / localWorkAllowed(ミラーの uid 紐づけ)', () => {
  it('meta.uid と現在の uid が一致するときだけ true', () => {
    expect(mirrorBelongsToUser(metaOf({ uid: 'uid-a' }), 'uid-a')).toBe(true)
    expect(mirrorBelongsToUser(metaOf({ uid: 'uid-a' }), 'uid-b')).toBe(false)
  })

  it('どちらかの uid が欠けている・空・空白は false(保守側)', () => {
    expect(mirrorBelongsToUser(metaOf({ uid: 'uid-a' }), null)).toBe(false)
    expect(mirrorBelongsToUser(metaOf({ uid: 'uid-a' }), undefined)).toBe(false)
    expect(mirrorBelongsToUser(metaOf({ uid: 'uid-a' }), '')).toBe(false)
    expect(mirrorBelongsToUser(metaOf({ uid: '' }), 'uid-a')).toBe(false)
    expect(mirrorBelongsToUser(null, 'uid-a')).toBe(false)
    expect(mirrorBelongsToUser(undefined, 'uid-a')).toBe(false)
  })

  it('localWorkAllowed は enabled フラグと uid 一致の両方を要求する', () => {
    expect(localWorkAllowed(metaOf({ uid: 'uid-a' }), 'uid-a')).toBe(true)
    expect(localWorkAllowed(metaOf({ uid: 'uid-a', enabled: false }), 'uid-a')).toBe(false)
    expect(localWorkAllowed(metaOf({ uid: 'uid-a' }), 'uid-other')).toBe(false)
    expect(localWorkAllowed(null, 'uid-a')).toBe(false)
  })
})

describe('normalizeOfflineEntries', () => {
  it('正常な entry はそのまま通る', () => {
    expect(normalizeOfflineEntries([{ modeId: 2, code: '1018', at, overwrite: true }])).toEqual([
      { modeId: 2, code: '1018', at, overwrite: true },
    ])
  })

  it('不正項目は項目単位で捨てる(throw しない)', () => {
    const out = normalizeOfflineEntries([
      { modeId: 2, code: '1018', at, overwrite: false },
      { modeId: 'x', code: '1019', at },
      { modeId: 2, code: '', at },
      { modeId: 2, code: 'あ'.repeat(SCAN_CODE_MAX_LENGTH + 1), at },
      { modeId: 2, code: 'hinotike-registration:c0b8fb34-9b1a-4b62-9f9c-2a6f0b6b6cde', at },
      'zz',
      null,
    ])
    expect(out).toEqual([{ modeId: 2, code: '1018', at, overwrite: false }])
  })

  it("at が日時として不正なら ''(サーバー側が確定時刻にフォールバックする)", () => {
    const out = normalizeOfflineEntries([{ modeId: 2, code: '1018', at: 'zz', overwrite: false }])
    expect(out[0]?.at).toBe('')
  })

  it('overwrite は true だけ true(他は false)', () => {
    const out = normalizeOfflineEntries([
      { modeId: 2, code: 'a', at, overwrite: 'yes' },
      { modeId: 2, code: 'b', at, overwrite: true },
    ])
    expect(out[0]?.overwrite).toBe(false)
    expect(out[1]?.overwrite).toBe(true)
  })

  it('上限(max)で打ち切る', () => {
    const out = normalizeOfflineEntries(
      [{ modeId: 2, code: 'a', at }, { modeId: 2, code: 'b', at }, { modeId: 2, code: 'c', at }],
      2,
    )
    expect(out.length).toBe(2)
  })

  it('配列以外は空', () => {
    expect(normalizeOfflineEntries(undefined)).toEqual([])
    expect(normalizeOfflineEntries({})).toEqual([])
  })
})

describe('offlineScanCheckResponse(payload を鏡としたローカル check)', () => {
  it('未記録の行は ok / 未 / 氏名', () => {
    const r = offlineScanCheckResponse(2, checkinMode, '1018', { 氏名: '田中桔平' }, at)
    expect(r.status).toBe('ok')
    expect(r.state).toBe('未')
    expect(r.name).toBe('田中桔平')
    expect(r.recordedAt).toBe('')
    expect(r.at).toBe(at)
  })

  it('済の行は duplicate / 済 / 記録日時', () => {
    const r = offlineScanCheckResponse(2, checkinMode, '1018', { 氏名: '田中', 来場済: '済', 来場日時: '2026-11-16 09:02 (JST)' }, at)
    expect(r.status).toBe('duplicate')
    expect(r.state).toBe('済')
    expect(r.recordedAt).toBe('2026-11-16 09:02 (JST)')
  })

  it('見つからない code は requireFound で not_found', () => {
    const r = offlineScanCheckResponse(2, checkinMode, '9999', null, at)
    expect(r.status).toBe('not_found')
    expect(r.name).toBeNull()
  })

  it('requireFound false なら payload 無しでも ok(復旧後の flush で sheet_missing/not_found が確定する)', () => {
    const mode = { ...checkinMode, requireFound: false }
    const r = offlineScanCheckResponse(2, mode, '9999', undefined, at)
    expect(r.status).toBe('ok')
    expect(r.state).toBe('未')
  })

  it('日時キーが無いモードもフラグだけで済を出せる', () => {
    const mode = { ...checkinMode, actions: [{ column: '配布済', columnAt: '', literal: '済', payloadKey: '配布済', payloadAtKey: '' }] }
    const r = offlineScanCheckResponse(2, mode, '1018', { 配布済: '済' }, at)
    expect(r.status).toBe('duplicate')
    expect(r.state).toBe('済')
  })
})

describe('stateOfPayload(scanRun と画面の共通根)', () => {
  it('payload のフラグ+日時から済/未と日時を出す', () => {
    expect(stateOfPayload({}, checkinMode)).toEqual({ state: '未', recordedAt: '' })
    expect(stateOfPayload({ 来場済: '未' }, checkinMode)).toEqual({ state: '未', recordedAt: '' })
    expect(stateOfPayload({ 来場日時: '2026-11-16 09:02 (JST)' }, checkinMode)).toEqual({ state: '済', recordedAt: '2026-11-16 09:02 (JST)' })
  })
})

describe('makeOfflineQueueId', () => {
  it('プレフィックス付きで、同じ引数でも衝突しない(同時読み取り)', () => {
    const a = makeOfflineQueueId(2, '1018', at)
    const b = makeOfflineQueueId(2, '1018', at)
    expect(a.startsWith('2|1018|')).toBe(true)
    expect(a).not.toBe(b)
  })
})

// normalizeScanModes は parseOfflineMeta の内部で使う(スナップショットのモード補正)。壊れた形でも落ちない。
describe('parseOfflineMeta のモード補正(normalizeScanModes)', () => {
  it('重複名前・不正項目はミラー側で除かれる', () => {
    const raw = metaJson({
      enabled: true,
      snapshotAt: at,
      itemCount: 1,
      config: { modes: [{ name: 'A', actions: [{ column: 'x' }] }, { name: 'A', actions: [{ column: 'y' }] }, { name: '', actions: [] }] },
    })
    const parsed = parseOfflineMeta(raw)
    expect(parsed?.config.modes.length).toBe(1)
    expect(normalizeScanModes(parsed?.config.modes)[0]?.name).toBe('A')
  })
})

// ── 端末ミラーの一一覧(絞り込み + 分页)──

const listRows = [
  { code: '1004', payload: { 氏名: '渡辺健斗', 学年: '1', クラス: '3', 備考: 'メモA', ボランティア: '清洗' } },
  { code: '200', payload: { 氏名: '田中桔平', 学年: '2', クラス: '1', 備考: '', ボランティア: null } },
  { code: '9', payload: { 氏名: '石坂律貴', ボランティア: '下草' } },
  { code: '1023', payload: { 氏名: '石坂律貴', 学年: '1', クラス: '3' } },
  { code: '5', payload: { 氏名: '空白学年', 学年: ' 1', クラス: '3' } },
]
const codesOf = (page: { rows: { code: string }[] }) => page.rows.map((row) => row.code)

describe('offlineItemsQuery(端末ミラーの絞り込み+分页)', () => {
  it('code は数値昇順(IDB の文字列 key 順ではなく)・total は一致総件数', () => {
    const page = offlineItemsQuery(listRows, {}, 10)
    expect(codesOf(page)).toEqual(['5', '9', '200', '1004', '1023'])
    expect(page.total).toBe(5)
    expect(page.nextCursor).toBe(null)
  })

  it('キーセットカーソル分页(code > cursor)', () => {
    const first = offlineItemsQuery(listRows, { cursor: undefined }, 2)
    expect(codesOf(first)).toEqual(['5', '9'])
    expect(first.nextCursor).toBe('9')
    expect(first.total).toBe(5) // total は limit に影響されない(exact count)
    const second = offlineItemsQuery(listRows, { cursor: first.nextCursor }, 2)
    expect(codesOf(second)).toEqual(['200', '1004'])
    const third = offlineItemsQuery(listRows, { cursor: second.nextCursor }, 2)
    expect(codesOf(third)).toEqual(['1023'])
    expect(third.nextCursor).toBe(null)
  })

  it('code・氏名・備考の部分一致(ilike の大文字小文字無視を再現)', () => {
    expect(codesOf(offlineItemsQuery(listRows, { code: '10' }, 10))).toEqual(['1004', '1023'])
    expect(codesOf(offlineItemsQuery(listRows, { name: '田中' }, 10))).toEqual(['200'])
    expect(codesOf(offlineItemsQuery(listRows, { name: ' TANAKA ' }, 10))).toEqual([])
    expect(codesOf(offlineItemsQuery(listRows, { remark: 'メモ' }, 10))).toEqual(['1004'])
    // 条件なし(空入力は normalizeFilter が null にする)は全件
    expect(offlineItemsQuery(listRows, { code: '  ' }, 10).total).toBe(5)
  })

  it('備考の有無(present=値あり・absent=欠落・null・空文字)', () => {
    expect(codesOf(offlineItemsQuery(listRows, { remarkState: 'present' }, 10))).toEqual(['1004'])
    expect(codesOf(offlineItemsQuery(listRows, { remarkState: 'absent' }, 10))).toEqual(['5', '9', '200', '1023'])
    // 有無と文字検索の同時指定は AND(「なし+検索」は 0 件)
    expect(offlineItemsQuery(listRows, { remarkState: 'absent', remark: 'メモ' }, 10).total).toBe(0)
  })

  it('年・組の選択(in. の完全一致・facet 同士は AND)と trim 非対称', () => {
    expect(codesOf(offlineItemsQuery(listRows, { years: ['1', '2'] }, 10))).toEqual(['200', '1004', '1023'])
    expect(codesOf(offlineItemsQuery(listRows, { years: '1', groups: ['3'] }, 10))).toEqual(['1004', '1023'])
    // payload の raw 値(' 1')と chip の trim 値('1')は server の eq と同じ「不一致」になる
    expect(codesOf(offlineItemsQuery(listRows, { years: ['1'] }, 10))).toEqual(['1004', '1023'])
  })

  it('ペア選択(年 AND 組、ペア同士は OR)', () => {
    expect(codesOf(offlineItemsQuery(listRows, { pairs: ['2:1', '1:3'] }, 10))).toEqual(['200', '1004', '1023'])
    expect(offlineItemsQuery(listRows, { pairs: ['9:9'] }, 10).total).toBe(0)
  })

  it('任意項目の絞り込み(present/absent/contains/in と異モードは AND)', () => {
    expect(codesOf(offlineItemsQuery(listRows, { filters: ['ボランティア|present'] }, 10))).toEqual(['9', '1004'])
    expect(codesOf(offlineItemsQuery(listRows, { filters: ['ボランティア|absent'] }, 10))).toEqual(['5', '200', '1023'])
    expect(codesOf(offlineItemsQuery(listRows, { filters: ['ボランティア|contains|洗'] }, 10))).toEqual(['1004'])
    expect(codesOf(offlineItemsQuery(listRows, { filters: ['ボランティア|in|下草|清洗'] }, 10))).toEqual(['9', '1004'])
    // contains の空値は条件にしない(normalizeKeyFilters と同じ)
    expect(offlineItemsQuery(listRows, { filters: ['ボランティア|contains|'] }, 10).total).toBe(5)
    // 異モード同時(present AND absent)= 0 件
    expect(offlineItemsQuery(listRows, { filters: ['ボランティア|present', 'ボランティア|absent'] }, 10).total).toBe(0)
    // 他の条件との AND
    expect(codesOf(offlineItemsQuery(listRows, { name: '石坂', filters: ['ボランティア|present'] }, 10))).toEqual(['9'])
  })

  it('limit は clampLimit の補正(不正値は既定 25)', () => {
    expect(offlineItemsQuery(listRows, { limit: 'abc' }).rows.length).toBe(5) // 5件 < 25 なので全部出た
    const clamped = offlineItemsQuery(listRows, { limit: '1' })
    expect(clamped.rows.length).toBe(1)
    expect(clamped.nextCursor).toBe('5')
    expect(offlineItemsQuery(listRows, { limit: '100' }).rows.length).toBe(5)
  })
})

describe('offlineFacets / offlineKeys(スナップショットからの導出)', () => {
  it('年・組の選択肢とペアの件数(facetCounts/facetPairCounts と同じ trim・昇順)', () => {
    const facets = offlineFacets(listRows)
    expect(facets.years).toEqual([{ value: '1', count: 3 }, { value: '2', count: 1 }]) // ' 1' は trim されて '1' に数える
    expect(facets.groups).toEqual([{ value: '1', count: 1 }, { value: '3', count: 3 }])
    expect(facets.pairs).toEqual([
      { year: '1', group: '3', count: 3 },
      { year: '2', group: '1', count: 1 },
    ])
    expect(facets.missingPairs).toBe(1) // 学年・クラスどちらか欠落(石坂律貴の行)
    expect(facets.truncated).toBe(false) // 全件スキャンなので server の scan 上限より完成度が高い
  })

  it('payload キーの発見(あり/なしの件数・選択肢・fromConfig=false)', () => {
    const keys = offlineKeys(listRows)
    expect(keys.scanned).toBe(5)
    expect(keys.truncated).toBe(false)
    const vol = keys.keys.find((entry) => entry.key === 'ボランティア')
    expect(vol).toBeDefined()
    expect(vol?.presentCount).toBe(2) // null は absent 側(datasetKeys のループと同じ判定)
    expect(vol?.absentCount).toBe(3)
    expect(vol?.options.map((option) => option.value)).toEqual(['下草', '清洗'])
    expect(keys.keys.every((entry) => entry.fromConfig === false && entry.seenInData === true)).toBe(true)
    expect(keys.keys.map((entry) => entry.key)).toEqual([...keys.keys.map((entry) => entry.key)].sort((a, b) => a.localeCompare(b, 'ja')))
  })
})
