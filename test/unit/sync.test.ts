import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SYNC_SETTINGS,
  chunk,
  isSafeSpreadsheetId,
  isSafeTableName,
  mapSheetRows,
  normalizeSettings,
  selectColumns,
  settingsFromDb,
  settingsToDb,
  sheetTitleFor,
  type SyncSettings,
} from '../../shared/utils/sync'

const base: SyncSettings = {
  spreadsheetId: '1Abc-def_1234567890',
  worksheet: 'フォームの回答 1',
  codeColumn: 'ID',
  includeColumns: ['ID', '学年', 'クラス', '氏名'],
  excludeColumns: [],
  filterColumn: null,
  filterValues: [],
  rename: { '領収書が必要な方はチェックをお願いします。': '領収書' },
  targetTable: 'items',
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
    const settings = { ...base, includeColumns: ['学年', '氏名'] }
    expect(selectColumns(headers, settings)).toEqual(['学年', '氏名', 'ID'])
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
      [['ID', '有効'], ['1001', ' 承認 ', ], ['1002', 2]],
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

describe('normalizeSettings(UI 入力の正規化)', () => {
  it('不正なテーブル名は既定(items)に補正', () => {
    expect(normalizeSettings({ targetTable: 'items; DROP' }).targetTable).toBe('items')
    expect(normalizeSettings({ targetTable: 'Items' }).targetTable).toBe('items')
    expect(normalizeSettings({ targetTable: 'items_copy2' }).targetTable).toBe('items_copy2')
  })

  it('不正なスプレッドシート ID は空文字に補正(同期は 400 で拒否される)', () => {
    expect(normalizeSettings({ spreadsheetId: 'abc' }).spreadsheetId).toBe('')
    expect(normalizeSettings({ spreadsheetId: '  1Abc-def_1234567890  ' }).spreadsheetId).toBe('1Abc-def_1234567890')
    expect(normalizeSettings({ spreadsheetId: '' }).spreadsheetId).toBe('')
  })

  it('空白だけの項目・空の rename エントリは取り除く', () => {
    const s = normalizeSettings({
      includeColumns: ['学年', '  ', '', 'クラス'],
      excludeColumns: ['   '],
      rename: { ' 元 ': ' 新 ', 'x': '' },
    })
    expect(s.includeColumns).toEqual(['学年', 'クラス'])
    expect(s.excludeColumns).toEqual([])
    expect(s.rename).toEqual({ 元: '新' })
  })

  it('codeColumn 空は既定(ID)に補正', () => {
    expect(normalizeSettings({ codeColumn: '' }).codeColumn).toBe('ID')
    expect(normalizeSettings({ codeColumn: ' 注文番号 ' }).codeColumn).toBe('注文番号')
  })

  it('filterColumn の空/空白は null(フィルタなし)、filterValues の空白項目は除く', () => {
    expect(normalizeSettings({ filterColumn: '' }).filterColumn).toBe(null)
    expect(normalizeSettings({ filterColumn: '  有効 ' }).filterColumn).toBe('有効')
    expect(normalizeSettings({ filterColumn: null }).filterColumn).toBe(null)
    expect(normalizeSettings({ filterValues: ['承認', ' ', '', '仮承認'] }).filterValues).toEqual(['承認', '仮承認'])
    expect(normalizeSettings({ filterValues: 'x' }).filterValues).toEqual([])
  })

  it('null / undefined は安全な既定(codeColumn=ID, targetTable=items)になる', () => {
    const s = normalizeSettings(null)
    expect(s.codeColumn).toBe(DEFAULT_SYNC_SETTINGS.codeColumn)
    expect(s.targetTable).toBe(DEFAULT_SYNC_SETTINGS.targetTable)
    // 取り込みカラムが空 = 全カラムのセマンティクスなので、既定リストは復元しない
    expect(s.includeColumns).toEqual([])
    expect(s.spreadsheetId).toBe('')
    expect(s.worksheet).toBe(null)
    expect(s.filterColumn).toBe(null)
    expect(s.filterValues).toEqual([])
    const again = normalizeSettings(undefined)
    expect(again).toEqual(s)
  })
})

describe('isSafeTableName / isSafeSpreadsheetId', () => {
  it('テーブル名は小文字英数字と _ のみ(先頭は英字)', () => {
    expect(isSafeTableName('items')).toBe(true)
    expect(isSafeTableName('items_2026')).toBe(true)
    expect(isSafeTableName('9items')).toBe(false)
    expect(isSafeTableName('items-2026')).toBe(false)
    expect(isSafeTableName('items;drop')).toBe(false)
    expect(isSafeTableName('')).toBe(false)
    expect(isSafeTableName(7)).toBe(false)
  })

  it('スプレッドシート ID は英数字・-_ の10文字以上', () => {
    expect(isSafeSpreadsheetId('1Abc-def_1234567890')).toBe(true)
    expect(isSafeSpreadsheetId('short')).toBe(false)
    expect(isSafeSpreadsheetId('id with space')).toBe(false)
    expect(isSafeSpreadsheetId(null)).toBe(false)
  })
})

describe('settingsFromDb / settingsToDb(DB 行 ↔ SyncSettings)', () => {
  it('DB の snake_case 行から SyncSettings に変換', () => {
    const s = settingsFromDb({
      spreadsheet_id: '1Abc-def_1234567890',
      worksheet: 'フォームの回答 1',
      code_column: 'ID',
      include_columns: ['学年', 'クラス'],
      exclude_columns: [],
      filter_column: '有効',
      filter_values: ['承認', '仮承認'],
      rename: { a: 'b' },
      target_table: 'items',
    })
    expect(s.includeColumns).toEqual(['学年', 'クラス'])
    expect(s.filterColumn).toBe('有効')
    expect(s.filterValues).toEqual(['承認', '仮承認'])
    expect(s.rename).toEqual({ a: 'b' })
  })

  it('行が無い場合は既定値', () => {
    expect(settingsFromDb(null)).toEqual(DEFAULT_SYNC_SETTINGS)
  })

  it('DB 行の不正値も normalizeSettings と同じ補正をする', () => {
    const s = settingsFromDb({ spreadsheet_id: 'x', target_table: 'Bad Name', code_column: '' })
    expect(s.spreadsheetId).toBe('')
    expect(s.targetTable).toBe('items')
    expect(s.codeColumn).toBe('ID')
  })

  it('settingsToDb は singleton 行(id=1)を確定させ、ラウンドトリップで同じ値に戻る', () => {
    const db = settingsToDb(base)
    expect(db.id).toBe(1)
    expect(settingsFromDb(db)).toEqual(base)
  })

  it('行フィルタ設定も DB 行 ↔ SyncSettings の往復で保たれる', () => {
    const s = { ...base, filterColumn: '有効', filterValues: ['承認', '仮承認'] }
    expect(settingsFromDb(settingsToDb(s))).toEqual(s)
  })
})

describe('chunk(バッチ分割)', () => {
  it('UPSERT_BATCH と同じ分割挙動', () => {
    expect(chunk([], 2)).toEqual([])
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]])
    expect(chunk([1], 200)).toEqual([[1]])
  })
})
