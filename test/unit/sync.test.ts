/**
 * 取り込み定義(shared/utils/sync.ts)の単体テスト。
 * 複数データセット化(2026-11-22)後は 1行 = 1データセット(SyncSource)。データ本体は Supabase に置かない。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SOURCE,
  IMPORT_PAGE_MAX,
  IMPORT_PAGE_SIZE,
  MAX_IMPORT_ROWS,
  SOURCE_MAX,
  SOURCE_NAME_MAX_LENGTH,
  chunk,
  clampImportLimit,
  importNextCursor,
  isSafeSourceName,
  isSafeSpreadsheetId,
  mapSheetRows,
  normalizeHeaders,
  normalizeSource,
  normalizeSources,
  payloadKeysOf,
  selectColumns,
  sheetTitleFor,
  sourceColumnFor,
  sourceFromDb,
  sourceToDb,
  type SyncRow,
  type SyncSource,
} from '../../shared/utils/sync'

const base: SyncSource = {
  id: 1,
  name: 'チケットA',
  spreadsheetId: '1Abc-def_1234567890',
  worksheet: 'フォームの回答 1',
  codeColumn: 'ID',
  includeColumns: ['ID', '学年', 'クラス', '氏名'],
  excludeColumns: [],
  filterColumn: null,
  filterValues: [],
  rename: { '領収書が必要な方はチェックをお願いします。': '領収書' },
  enabled: true,
  updatedAt: null,
  updatedBy: null,
}

describe('selectColumns(カラム選別)', () => {
  const headers = ['ID', '学年', 'クラス', '氏名', '備考', '不要列']

  it('includeColumns の許容リストのみ残す', () => {
    expect(selectColumns(headers, base)).toEqual(['ID', '学年', 'クラス', '氏名'])
  })

  it('includeColumns が空なら全カラム(excludeColumns が空なのでそのまま)', () => {
    expect(selectColumns(headers, { ...base, includeColumns: [] })).toEqual(headers)
  })

  it('includeColumns が空のとき excludeColumns を除外', () => {
    expect(selectColumns(headers, { ...base, includeColumns: [], excludeColumns: ['不要列', '備考'] })).toEqual([
      'ID',
      '学年',
      'クラス',
      '氏名',
    ])
  })

  it('codeColumn は選別リストに無くても常に保持する(照会キー必須)', () => {
    const source = { ...base, includeColumns: ['学年', '氏名'] }
    expect(selectColumns(headers, source)).toEqual(['学年', '氏名', 'ID'])
  })

  it('includeColumns に無いヘッダー名はリストから落ちる(シート側のカラム増を無視)', () => {
    expect(selectColumns([...headers, '新列'], base)).toEqual(['ID', '学年', 'クラス', '氏名'])
  })
})

describe('mapSheetRows(シート値 → code + payload)', () => {
  const values = [
    ['ID', '学年', 'クラス', '氏名'],
    ['1001', '1年', '3組', 'ひの 太郎'],
    ['1002', '2年', '1組', ''],
    ['', '', '', 'code 空の行'],
    ['1003', '', '', '氏名のみ'],
  ]

  it('code が空の行はスキップし、残りを code + payload に変換', () => {
    const mapped = mapSheetRows(values, base)
    expect(mapped.codeColumnMissing).toBe(false)
    expect(mapped.skipped).toBe(1)
    expect(mapped.rows.map((r) => r.code)).toEqual(['1001', '1002', '1003'])
    expect(mapped.rows[0].payload).toEqual({ 学年: '1年', クラス: '3組', 氏名: 'ひの 太郎' })
  })

  it('空の値(undefined / 空文字)は payload に載せない', () => {
    const mapped = mapSheetRows(values, base)
    expect(mapped.rows[1].payload).toEqual({ 学年: '2年', クラス: '1組' })
    expect(mapped.rows[2].payload).toEqual({ 氏名: '氏名のみ' })
  })

  it('rename を payload のキー名に適用', () => {
    const mapped = mapSheetRows(
      [['ID', '領収書が必要な方はチェックをお願いします。'], ['2001', '必要']],
      { ...base, includeColumns: [] },
    )
    expect(mapped.rows[0].payload).toEqual({ 領収書: '必要' })
  })

  it('codeColumn がヘッダーに無いと codeColumnMissing=true(取り込み不可)', () => {
    const mapped = mapSheetRows(values, { ...base, codeColumn: '注文番号' })
    expect(mapped.codeColumnMissing).toBe(true)
    expect(mapped.rows).toEqual([])
  })

  it('数値や false のセルは文字列化して載せる', () => {
    const mapped = mapSheetRows(
      [['ID', '購入金額', '個数'], ['3001', 1500, 2]],
      { ...base, includeColumns: ['ID', '購入金額', '個数'] },
    )
    expect(mapped.rows[0].payload).toEqual({ 購入金額: '1500', 個数: '2' })
  })

  it('空のヘッダーセルは column_N の暫定名になる(code 判定には影響しない)', () => {
    const mapped = mapSheetRows([['ID', ''], ['4001', '値']], { ...base, includeColumns: [] })
    expect(mapped.headers).toEqual(['ID', 'column_2'])
  })
})

describe('mapSheetRows(行フィルタ filterColumn / filterValues)', () => {
  const values = [
    ['ID', '氏名', '有効'],
    ['1001', 'ひの 太郎', '承認'],
    ['1002', 'さかもと 花子', '仮承認'],
    ['1003', 'あかの 助', '却下'],
    ['1004', 'うかの 郎', ''],
    ['', 'code 空', '承認'],
  ]

  it('filterColumn 未設定なら全行取り込み(filtered=0)', () => {
    const mapped = mapSheetRows(values, { ...base, includeColumns: [] })
    expect(mapped.rows.map((r) => r.code)).toEqual(['1001', '1002', '1003', '1004'])
    expect(mapped.filtered).toBe(0)
    expect(mapped.skipped).toBe(1)
  })

  it('filterValues のいずれかに一致する行のみ取り込む(複数値)', () => {
    const mapped = mapSheetRows(values, { ...base, includeColumns: [], filterColumn: '有効', filterValues: ['承認', '仮承認'] })
    expect(mapped.rows.map((r) => r.code)).toEqual(['1001', '1002'])
    expect(mapped.filtered).toBe(2)
    expect(mapped.skipped).toBe(1)
  })

  it('セル値は trim して比較。数値も文字列化して照合する', () => {
    const mapped = mapSheetRows(
      [['ID', '有効'], ['1001', ' 承認 '], ['1002', 2]],
      { ...base, includeColumns: [], filterColumn: '有効', filterValues: ['承認', '2'] },
    )
    expect(mapped.rows.map((r) => r.code)).toEqual(['1001', '1002'])
    expect(mapped.filtered).toBe(0)
  })

  it('filterValues が空リストなら「値が非空なら有効」', () => {
    const mapped = mapSheetRows(values, { ...base, includeColumns: [], filterColumn: '有効', filterValues: [] })
    expect(mapped.rows.map((r) => r.code)).toEqual(['1001', '1002', '1003'])
    expect(mapped.filtered).toBe(1)
  })

  it('code 空の行はフィルタより先に skipped として扱われる', () => {
    const mapped = mapSheetRows(values, { ...base, includeColumns: [], filterColumn: '有効', filterValues: ['承認'] })
    expect(mapped.skipped).toBe(1)
    expect(mapped.filtered).toBe(3)
  })

  it('filterColumn がヘッダーに無いと filterColumnMissing=true(取り込み不可)', () => {
    const mapped = mapSheetRows(values, { ...base, includeColumns: [], filterColumn: '存在しない列', filterValues: ['承認'] })
    expect(mapped.filterColumnMissing).toBe(true)
    expect(mapped.codeColumnMissing).toBe(false)
    expect(mapped.rows).toEqual([])
  })
})

describe('sheetTitleFor(対象ワークシート選択)', () => {
  it('設定名と一致するタイトルを選ぶ', () => {
    expect(sheetTitleFor(['Sheet1', 'フォームの回答 1'], 'フォームの回答 1')).toBe('フォームの回答 1')
  })

  it('設定名が一覧に無いときは最初のシートにフォールバック', () => {
    expect(sheetTitleFor(['Sheet1', 'Sheet2'], '存在しないシート')).toBe('Sheet1')
  })

  it('worksheet 未設定(null / 空文字)は最初のシート', () => {
    expect(sheetTitleFor(['Sheet1', 'Sheet2'], null)).toBe('Sheet1')
    expect(sheetTitleFor(['Sheet1', 'Sheet2'], '')).toBe('Sheet1')
  })

  it('シートが0件なら null', () => {
    expect(sheetTitleFor([], null)).toBe(null)
  })
})

describe('normalizeSource(データセット定義の正規化)', () => {
  it('不正なスプレッドシート ID は空文字に補正(取り込みは 400 で拒否される)', () => {
    expect(normalizeSource({ spreadsheetId: 'abc' }).spreadsheetId).toBe('')
    expect(normalizeSource({ spreadsheetId: '  1Abc-def_1234567890  ' }).spreadsheetId).toBe('1Abc-def_1234567890')
    expect(normalizeSource({ spreadsheetId: '' }).spreadsheetId).toBe('')
  })

  it('名前は trim + 上限で切る。空名は 名称未設定(チップと UNIQUE のキーとして必ず出す)', () => {
    expect(normalizeSource({ name: '  A ' }).name).toBe('A')
    expect(normalizeSource({ name: '' }).name).toBe('名称未設定')
    expect(normalizeSource({ name: 'あ'.repeat(SOURCE_NAME_MAX_LENGTH + 5) }).name).toBe('あ'.repeat(SOURCE_NAME_MAX_LENGTH))
  })

  it('空白だけの項目・空の rename エントリは取り除く', () => {
    const s = normalizeSource({
      includeColumns: ['学年', '  ', '', 'クラス'],
      excludeColumns: ['   '],
      rename: { ' 元 ': ' 新 ', 'x': '' },
    })
    expect(s.includeColumns).toEqual(['学年', 'クラス'])
    expect(s.excludeColumns).toEqual([])
    expect(s.rename).toEqual({ 元: '新' })
  })

  it('codeColumn 空は既定(ID)に補正', () => {
    expect(normalizeSource({ codeColumn: '' }).codeColumn).toBe(DEFAULT_SOURCE.codeColumn)
    expect(normalizeSource({ codeColumn: ' 注文番号 ' }).codeColumn).toBe('注文番号')
  })

  it('filterColumn の空/空白は null(フィルタなし)、filterValues の空白項目は除く', () => {
    expect(normalizeSource({ filterColumn: '' }).filterColumn).toBe(null)
    expect(normalizeSource({ filterColumn: '  有効 ' }).filterColumn).toBe('有効')
    expect(normalizeSource({ filterValues: ['承認', ' ', '', '仮承認'] }).filterValues).toEqual(['承認', '仮承認'])
    expect(normalizeSource({ filterValues: 'x' }).filterValues).toEqual([])
  })

  it('enabled は false のみ無効(文字列や欠落は有効)', () => {
    expect(normalizeSource({ enabled: false }).enabled).toBe(false)
    expect(normalizeSource({ enabled: 'false' }).enabled).toBe(true)
    expect(normalizeSource({}).enabled).toBe(true)
    expect(normalizeSource(null).enabled).toBe(true)
  })

  it('id は整数だけ通る(未作成のドラフトは null)', () => {
    expect(normalizeSource({ id: 3 }).id).toBe(3)
    expect(normalizeSource({ id: '3' }).id).toBe(null)
    expect(normalizeSource({ id: 1.5 }).id).toBe(null)
    expect(normalizeSource({}).id).toBe(null)
  })

  it("null / undefined は安全な既定(codeColumn=ID / spreadsheetId は空 / worksheet=null)になる", () => {
    const s = normalizeSource(null)
    expect(s.codeColumn).toBe(DEFAULT_SOURCE.codeColumn)
    expect(s.spreadsheetId).toBe('')
    expect(s.worksheet).toBe(null)
    expect(s.filterColumn).toBe(null)
    expect(s.filterValues).toEqual([])
    // 取り込みカラムが空 = 全カラムのセマンティクスなので、既定リストは復元しない
    expect(s.includeColumns).toEqual([])
    expect(normalizeSource(undefined)).toEqual(s)
  })
})

describe('normalizeSources(複数データセットのリスト)', () => {
  it('配列を順に正規化する(非配列は空リスト)', () => {
    expect(normalizeSources([{ name: 'A' }, { name: 'B' }]).map((s) => s.name)).toEqual(['A', 'B'])
    expect(normalizeSources('x')).toEqual([])
    expect(normalizeSources(null)).toEqual([])
  })

  it('名前重複は最初の1つだけ残す(DB の UNIQUE と同じ契約)', () => {
    const out = normalizeSources([{ name: 'A', spreadsheetId: '1Abc-def_1234567890' }, { name: ' A ' }])
    expect(out.length).toBe(1)
    expect(out[0]?.spreadsheetId).toBe('1Abc-def_1234567890')
  })

  it('SOURCE_MAX 超は打ち切る(設定画面の膨張とシート読み取りの連打を防ぐ)', () => {
    const many = Array.from({ length: SOURCE_MAX + 5 }, (_, i) => ({ name: `S${i}` }))
    expect(normalizeSources(many).length).toBe(SOURCE_MAX)
  })
})

describe('sourceFromDb / sourceToDb(DB 行 ↔ SyncSource)', () => {
  it('DB の snake_case 行から SyncSource に変換', () => {
    const s = sourceFromDb({
      id: 7,
      name: 'チケットB',
      spreadsheet_id: '1Abc-def_1234567890',
      worksheet: 'フォームの回答 1',
      code_column: 'ID',
      include_columns: ['学年', 'クラス'],
      exclude_columns: [],
      filter_column: '有効',
      filter_values: ['承認', '仮承認'],
      rename: { a: 'b' },
      enabled: false,
    })
    expect(s?.id).toBe(7)
    expect(s?.includeColumns).toEqual(['学年', 'クラス'])
    expect(s?.filterColumn).toBe('有効')
    expect(s?.filterValues).toEqual(['承認', '仮承認'])
    expect(s?.rename).toEqual({ a: 'b' })
    expect(s?.enabled).toBe(false)
  })

  it('行が無い場合は null(既定値を黙って作らない = 0行は UI 側で rowMissing を出す)', () => {
    expect(sourceFromDb(null)).toBe(null)
    expect(sourceFromDb(undefined)).toBe(null)
  })

  it('DB 行の不正値も normalizeSource と同じ補正をする', () => {
    const s = sourceFromDb({ spreadsheet_id: 'x', code_column: '' })
    expect(s?.spreadsheetId).toBe('')
    expect(s?.codeColumn).toBe('ID')
  })

  it('sourceToDb は id を载せ、ラウンドトリップで同じ値に戻る(id 無しは insert payload)', () => {
    const db = sourceToDb(base)
    expect(db.id).toBe(1)
    expect(db.updated_at).toBeTypeOf('string')
    // updated_at/updated_by は保存時にサーバーが立てる値なので、往復比較はそれを base の値に戻す
    const back = sourceFromDb({ ...db, updated_at: base.updatedAt, updated_by: base.updatedBy })
    expect(back).toEqual(base)
    const draft = sourceToDb({ ...base, id: null })
    expect(draft.id).toBeUndefined()
  })
})

describe('import の分页カーソルと limit 補正', () => {
  const rows: SyncRow[] = [
    { code: '1', payload: {} },
    { code: '2', payload: {} },
    { code: '3', payload: {} },
  ]

  it('limit を満たすページは次の offset をカーソルにする', () => {
    expect(importNextCursor(rows.slice(0, 2), 0, 2)).toBe('2')
    expect(importNextCursor(rows.slice(0, 2), 2, 2)).toBe('4')
  })

  it('limit 未満(末尾)は null', () => {
    expect(importNextCursor(rows.slice(0, 1), 0, 2)).toBe(null)
    expect(importNextCursor([], 0, 2)).toBe(null)
  })

  it('clampImportLimit は 1〜IMPORT_PAGE_MAX に補正し、不正値は既定', () => {
    expect(clampImportLimit('100')).toBe(100)
    expect(clampImportLimit('1')).toBe(1)
    expect(clampImportLimit('999')).toBe(IMPORT_PAGE_MAX)
    expect(clampImportLimit('0')).toBe(1)
    expect(clampImportLimit('-5')).toBe(1)
    expect(clampImportLimit('zz')).toBe(IMPORT_PAGE_SIZE)
    expect(clampImportLimit(undefined)).toBe(IMPORT_PAGE_SIZE)
  })
})

describe('payloadKeysOf / sourceColumnFor / normalizeHeaders', () => {
  it('取り込み後の payload キーを集めて昇順に出す(プレビュー表示用。環境差のない code-unit 順)', () => {
    expect(payloadKeysOf([{ code: '1', payload: { 氏名: 'a', 学年: 'b' } }, { code: '2', payload: { 備考: 'c' } }])).toEqual([
      '備考',
      '学年',
      '氏名',
    ])
    expect(payloadKeysOf([])).toEqual([])
  })

  it('sourceColumnFor は rename を逆引きし、対象が無ければキー名そのまま', () => {
    expect(sourceColumnFor('領収書', base.rename)).toBe('領収書が必要な方はチェックをお願いします。')
    expect(sourceColumnFor('氏名', base.rename)).toBe('氏名')
  })

  it('normalizeHeaders は空セルを column_N にする(数値ヘッダーも文字列化)', () => {
    expect(normalizeHeaders(['ID', '', null, undefined, 7])).toEqual(['ID', 'column_2', 'column_3', 'column_4', '7'])
    expect(normalizeHeaders([])).toEqual([])
  })
})

describe('isSafeSourceName / isSafeSpreadsheetId', () => {
  it('データセット名は空・空白・長さ超を使えない', () => {
    expect(isSafeSourceName('チケットA')).toBe(true)
    expect(isSafeSourceName('  A  ')).toBe(true)
    expect(isSafeSourceName('')).toBe(false)
    expect(isSafeSourceName('   ')).toBe(false)
    expect(isSafeSourceName('あ'.repeat(SOURCE_NAME_MAX_LENGTH + 1))).toBe(false)
    expect(isSafeSourceName(7)).toBe(false)
  })

  it('スプレッドシート ID は英数字・-_ の10文字以上', () => {
    expect(isSafeSpreadsheetId('1Abc-def_1234567890')).toBe(true)
    expect(isSafeSpreadsheetId('short')).toBe(false)
    expect(isSafeSpreadsheetId('id with space')).toBe(false)
    expect(isSafeSpreadsheetId(null)).toBe(false)
  })
})

describe('chunk(バッチ分割)と上限定数', () => {
  it('分割挙動', () => {
    expect(chunk([], 2)).toEqual([])
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]])
    expect(chunk([1], 200)).toEqual([[1]])
  })

  it('取り込み上限は端末側の保存上限(OFFLINE_ITEM_MAX)より小さい', async () => {
    const { OFFLINE_ITEM_MAX } = await import('../../shared/utils/offline')
    expect(MAX_IMPORT_ROWS).toBeGreaterThan(0)
    expect(MAX_IMPORT_ROWS).toBeLessThanOrEqual(OFFLINE_ITEM_MAX)
  })
})
