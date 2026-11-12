import { describe, expect, it } from 'vitest'
import {
  a1Cell,
  columnLetter,
  normalizeHeaders,
  quoteSheetTitle,
  sourceColumnFor,
} from '../../shared/utils/sync'

describe('columnLetter(列表記)', () => {
  it('0基点のセット番号を A1 の列名にする', () => {
    expect(columnLetter(0)).toBe('A')
    expect(columnLetter(1)).toBe('B')
    expect(columnLetter(25)).toBe('Z')
    expect(columnLetter(26)).toBe('AA')
    expect(columnLetter(27)).toBe('AB')
    expect(columnLetter(52)).toBe('BA')
    expect(columnLetter(701)).toBe('ZZ')
    expect(columnLetter(702)).toBe('AAA')
  })
})

describe('quoteSheetTitle / a1Cell(セル番地)', () => {
  it('空白入りシート名をシングルクォートで囲む', () => {
    expect(quoteSheetTitle('フォームの回答 1')).toBe("'フォームの回答 1'")
    expect(quoteSheetTitle("it's")).toBe("'it''s'")
  })

  it('セット番号 0基点・行番号 1起点で A1 を組む', () => {
    expect(a1Cell('Sheet1', 6, 5)).toBe("'Sheet1'!G5")
    expect(a1Cell('フォームの回答 1', 0, 2)).toBe("'フォームの回答 1'!A2")
  })
})

describe('normalizeHeaders(ヘッダー正規化)', () => {
  it('空セルは column_N にする(mapSheetRows と同じ根)', () => {
    expect(normalizeHeaders(['ID', '', null, undefined, '備考'])).toEqual([
      'ID',
      'column_2',
      'column_3',
      'column_4',
      '備考',
    ])
  })
})

describe('sourceColumnFor(payload キー → シート元カラム)', () => {
  it('rename の逆引きで元カラム名を返す', () => {
    expect(sourceColumnFor('領収書', { '領収書が必要な方はチェックをお願いします。': '領収書' })).toBe(
      '領収書が必要な方はチェックをお願いします。',
    )
    expect(sourceColumnFor('備考', {})).toBe('備考')
    expect(sourceColumnFor('入金額', { '備考': 'メモ' })).toBe('入金額')
  })
})
