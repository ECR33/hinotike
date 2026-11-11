import { describe, expect, it } from 'vitest'
import {
  clampLimit,
  containsPattern,
  compareFacetValues,
  escapeIlikePattern,
  facetCounts,
  FACET_MAX_VALUES,
  FACET_VALUE_MAX_LENGTH,
  ITEM_PAGE_SIZE,
  ITEM_PAGE_SIZE_MAX,
  ITEM_GROUP_KEY,
  ITEM_PAIR_MAX,
  ITEM_YEAR_KEY,
  nextCursor,
  normalizeFilter,
  normalizePairs,
  normalizeSelection,
  pairConditions,
  pairKey,
  parsePair,
  payloadTextColumn,
  payloadValue,
  facetPairCounts,
  missingPairCount,
  quoteInValue,
  SEARCH_FILTER_MAX_LENGTH,
} from '../../shared/utils/items'

describe('normalizeFilter(検索入力の正規化)', () => {
  it('前後の空白だけ・空文字・非文字列は条件なし(null)', () => {
    expect(normalizeFilter('')).toBeNull()
    expect(normalizeFilter('   ')).toBeNull()
    expect(normalizeFilter(undefined)).toBeNull()
    expect(normalizeFilter(null)).toBeNull()
    expect(normalizeFilter(123)).toBeNull()
  })

  it('入力値は前後の空白を取って返す', () => {
    expect(normalizeFilter('  1004  ')).toBe('1004')
    expect(normalizeFilter('田中 桔平')).toBe('田中 桔平') // 内部の空白は保持(氏名入力の一致を落とさない)
  })

  it('長入力は上限で切る(高コストな照合防止)', () => {
    expect(normalizeFilter('a'.repeat(SEARCH_FILTER_MAX_LENGTH + 10))).toHaveLength(SEARCH_FILTER_MAX_LENGTH)
  })
})

describe('containsPattern / escapeIlikePattern(PostgREST の ilike)', () => {
  it('条件なしの入力は null(フィルタを追加しない)', () => {
    expect(containsPattern('')).toBeNull()
    expect(containsPattern('  ')).toBeNull()
  })

  it('部分一致パターンに包む', () => {
    expect(containsPattern('田中')).toBe('%田中%')
  })

  it('% と _ と \\ はリテラルに守る(氏名に % が混ざっても任意文字扱いにならない)', () => {
    expect(escapeIlikePattern('a%b')).toBe('a\\%b')
    expect(escapeIlikePattern('a_b')).toBe('a\\_b')
    expect(escapeIlikePattern('a\\b')).toBe('a\\\\b')
    expect(containsPattern('100%')).toBe('%100\\%%')
  })
})

describe('payloadTextColumn / payloadValue(jsonb payload の参照と取り出し)', () => {
  it('キーを引用した payload ->> キー のカラム参照を作る', () => {
    expect(payloadTextColumn('氏名')).toBe('payload->>"氏名"')
    expect(payloadTextColumn('ひのドッグ(個数)')).toBe('payload->>"ひのドッグ(個数)"')
  })

  it('欠落・null・非文字列を安全に文字列化する', () => {
    const payload = { 学年: '9', クラス: 5, 氏名: null }
    expect(payloadValue(payload, '学年')).toBe('9')
    expect(payloadValue(payload, 'クラス')).toBe('5')
    expect(payloadValue(payload, '氏名')).toBe('')
    expect(payloadValue(payload, '備考')).toBe('')
    expect(payloadValue(undefined, '氏名')).toBe('')
  })
})

describe('clampLimit(ページサイズ補正)', () => {
  it('文字列・数値を受け取り範囲内に補正する', () => {
    expect(clampLimit('10')).toBe(10)
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(-5)).toBe(1)
    expect(clampLimit(ITEM_PAGE_SIZE_MAX + 1)).toBe(ITEM_PAGE_SIZE_MAX)
  })

  it('不正値は既定のページサイズ', () => {
    expect(clampLimit(undefined)).toBe(ITEM_PAGE_SIZE)
    expect(clampLimit('abc')).toBe(ITEM_PAGE_SIZE)
    expect(clampLimit(2.5)).toBe(ITEM_PAGE_SIZE)
  })
})

describe('nextCursor(code 昇順キーセットの次カーソル)', () => {
  const rows = [{ code: '1004', payload: {} }, { code: '1018', payload: {} }, { code: '3022', payload: {} }]

  it('limit を満たすページは末尾の code を次カーソルにする', () => {
    expect(nextCursor(rows, 3)).toBe('3022')
  })

  it('limit 未満(最終ページ)は null', () => {
    expect(nextCursor(rows, 10)).toBeNull()
    expect(nextCursor([], 25)).toBeNull()
  })
})

describe('normalizeSelection(年・組の選択値)', () => {
  it('単数・複数・カンマ区切りを受け取り、重複と空要素を除く', () => {
    expect(normalizeSelection('1')).toEqual(['1'])
    expect(normalizeSelection(['1', '2'])).toEqual(['1', '2'])
    expect(normalizeSelection('1,2,1')).toEqual(['1', '2'])
    expect(normalizeSelection([' 1 ', '', '2'])).toEqual(['1', '2'])
  })

  it('非文字列・空は選択なし(空配列)', () => {
    expect(normalizeSelection(undefined)).toEqual([])
    expect(normalizeSelection(null)).toEqual([])
    expect(normalizeSelection('')).toEqual([])
    expect(normalizeSelection('   ')).toEqual([])
    expect(normalizeSelection([123])).toEqual([])
  })

  it('個数と1つの長さの上限で切る(大量の in.() 値・長値を防ぐ)', () => {
    expect(normalizeSelection(Array.from({ length: FACET_MAX_VALUES + 5 }, (_, i) => String(i)))).toHaveLength(
      FACET_MAX_VALUES,
    )
    expect(normalizeSelection('a'.repeat(FACET_VALUE_MAX_LENGTH + 10))).toHaveLength(1)
    expect(normalizeSelection('a'.repeat(FACET_VALUE_MAX_LENGTH + 10))[0]).toHaveLength(FACET_VALUE_MAX_LENGTH)
  })
})

describe('quoteInValue(PostgREST の in.() の値)', () => {
  it('値をダブルクォートで守る(カンマ・括弧が混ざっても区切りとして扱われない)', () => {
    expect(quoteInValue('1')).toBe('"1"')
    expect(quoteInValue('a,b')).toBe('"a,b"')
    expect(quoteInValue('(x)')).toBe('"(x)"')
  })

  it('内部の " は二重にして引用の区切りにしない', () => {
    expect(quoteInValue('a"b')).toBe('"a""b"')
  })
})

describe('facetCounts / compareFacetValues(選択肢の生成と順序)', () => {
  it('欠落・空・空白は選択肢から除き、件数を数える', () => {
    expect(facetCounts(['1', '1', '2', '', '  ', null, undefined])).toEqual([
      { value: '1', count: 2 },
      { value: '2', count: 1 },
    ])
    expect(facetCounts([])).toEqual([])
  })

  it('数字は数字順、それ以外は比較順', () => {
    expect(facetCounts(['10', '2', '9']).map((o) => o.value)).toEqual(['2', '9', '10'])
    expect(facetCounts(['B', 'A']).map((o) => o.value)).toEqual(['A', 'B'])
    expect(compareFacetValues('2', '10')).toBeLessThan(0)
  })
})

describe('parsePair / normalizePairs(年と組の対応指定)', () => {
  it('年:組 をペアにする(区切りが無い・空・空白-only は選択対象にしない)', () => {
    expect(parsePair('1:3')).toEqual({ year: '1', group: '3' })
    expect(parsePair('  1 : 3  ')).toEqual({ year: '1', group: '3' })
    expect(parsePair('1')).toBeNull()
    expect(parsePair('1:')).toBeNull()
    expect(parsePair(':3')).toBeNull()
    expect(parsePair('')).toBeNull()
    expect(parsePair('   :   ')).toBeNull()
  })

  it('どちらかの値が長さ上限を超えたら null(長い値の eq.() を作らない)', () => {
    expect(parsePair(`${'a'.repeat(FACET_VALUE_MAX_LENGTH + 1)}:3`)).toBeNull()
    expect(parsePair(`1:${'a'.repeat(FACET_VALUE_MAX_LENGTH + 1)}`)).toBeNull()
  })

  it('カンマ区切り・配列を受け取り、重複を除き上限で切る', () => {
    expect(normalizePairs('1:3,2:1')).toEqual([
      { year: '1', group: '3' },
      { year: '2', group: '1' },
    ])
    expect(normalizePairs(['1:3', '1:3', '2:1'])).toEqual([
      { year: '1', group: '3' },
      { year: '2', group: '1' },
    ])
    // 壊れた要素は捨てて残りのペアは使う(1件の不正値で絞り込み全体を止めない)
    expect(normalizePairs('1:3,junk,2:1')).toEqual([
      { year: '1', group: '3' },
      { year: '2', group: '1' },
    ])
    expect(normalizePairs('bad')).toEqual([])
    expect(normalizePairs(undefined)).toEqual([])
    expect(normalizePairs([123])).toEqual([])
    expect(
      normalizePairs(Array.from({ length: ITEM_PAIR_MAX + 10 }, (_, i) => `${i}:${i + 1}`)),
    ).toHaveLength(ITEM_PAIR_MAX)
  })
})

describe('pairConditions(年と組の対応を PostgREST の論理木にする)', () => {
  const year = payloadTextColumn(ITEM_YEAR_KEY)
  const group = payloadTextColumn(ITEM_GROUP_KEY)

  it('1ペアは and(年.eq,組.eq)、複数ペアはカンマ区切り(supabase-js の .or() が or=(...) に包む)', () => {
    expect(pairConditions([{ year: '1', group: '3' }])).toBe(`and(${year}.eq."1",${group}.eq."3")`)
    expect(pairConditions([{ year: '1', group: '3' }, { year: '2', group: '1' }])).toBe(
      `and(${year}.eq."1",${group}.eq."3"),and(${year}.eq."2",${group}.eq."1")`,
    )
  })

  it('値の特殊文字は引用して守る(カンマ・引用符が論理木の区切りや終端にならない)', () => {
    expect(pairConditions([{ year: 'a,b', group: 'c"d' }])).toBe(`and(${year}.eq."a,b",${group}.eq."c""d")`)
  })

  it('空選択は空文字(フィルタを適用しない)', () => {
    expect(pairConditions([])).toBe('')
  })
})

describe('facetPairCounts / missingPairCount(マトリクスのセル)', () => {
  it('年・組の両方ある行だけを数え、年→組の昇順にする', () => {
    expect(
      facetPairCounts([
        { year: '2', group: '1' },
        { year: '1', group: '3' },
        { year: '1', group: '3' },
        { year: '10', group: '2' },
      ]),
    ).toEqual([
      { year: '1', group: '3', count: 2 },
      { year: '2', group: '1', count: 1 },
      { year: '10', group: '2', count: 1 },
    ])
  })

  it('どちらかが欠ける行はセルを作らない(マトリクスでは選べない)', () => {
    expect(
      facetPairCounts([{ year: '1', group: null }, { year: null, group: '3' }, { year: '', group: '3' }]),
    ).toEqual([])
    expect(
      missingPairCount([{ year: '1', group: '3' }, { year: '1', group: null }, { year: null, group: null }]),
    ).toBe(2)
  })

  it('pairKey はセルの識別子(選択状態の集合に使う)', () => {
    expect(pairKey({ year: '1', group: '3' })).toBe('1:3')
  })
})
