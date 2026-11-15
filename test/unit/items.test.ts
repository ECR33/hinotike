import { describe, expect, it } from 'vitest'
import {
  clampLimit,
  containsPattern,
  compareFacetValues,
  escapeIlikePattern,
  escapePayloadKey,
  facetCounts,
  FACET_MAX_VALUES,
  FACET_VALUE_MAX_LENGTH,
  ITEM_PAGE_SIZE,
  ITEM_PAGE_SIZE_MAX,
  ITEM_GROUP_KEY,
  ITEM_PAIR_MAX,
  ITEM_YEAR_KEY,
  isFilterableKey,
  keyAbsentConditions,
  KEY_FILTER_MAX,
  KEY_NAME_MAX_LENGTH,
  nextCursor,
  normalizeFilter,
  normalizeKeyFilters,
  normalizePairs,
  normalizeRemarkState,
  normalizeSelection,
  pairConditions,
  pairKey,
  parseKeyFilter,
  parsePair,
  payloadTextColumn,
  payloadValue,
  productOrderKeys,
  sameKeyFilters,
  serializeKeyFilters,
  quantityName,
  isQuantityKey,
  facetPairCounts,
  missingPairCount,
  quoteInValue,
  remarkAbsentConditions,
  SEARCH_FILTER_MAX_LENGTH,
} from '../../shared/utils/items'
import { DEFAULT_SYNC_SETTINGS } from '../../shared/utils/sync'

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

describe('normalizeRemarkState / remarkAbsentConditions(備考の有無の絞り込み)', () => {
  it('認識した値はそのまま、それ以外は条件なし(any)', () => {
    expect(normalizeRemarkState('present')).toBe('present')
    expect(normalizeRemarkState('absent')).toBe('absent')
    expect(normalizeRemarkState('any')).toBe('any')
    expect(normalizeRemarkState('PRESENT')).toBe('present') // 大文字・空白は吸収する
    expect(normalizeRemarkState('  absent  ')).toBe('absent')
    expect(normalizeRemarkState('present,absent')).toBe('any') // 複数値は条件なし(壊れた値で絞り込みを止めない)
    expect(normalizeRemarkState('yes')).toBe('any')
    expect(normalizeRemarkState(undefined)).toBe('any')
    expect(normalizeRemarkState(null)).toBe('any')
    expect(normalizeRemarkState(123)).toBe('any')
  })

  it('「なし」は備考キーの欠落(null)と空文字の両方を包含する論理木にする', () => {
    expect(remarkAbsentConditions()).toBe('payload->>"備考".is.null,payload->>"備考".eq.""')
    // キー名を変えられる(同期設定の rename 後も追随できるように引数で渡す)
    expect(remarkAbsentConditions('メモ')).toBe('payload->>"メモ".is.null,payload->>"メモ".eq.""')
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

describe('productOrderKeys / quantityName / isQuantityKey(商品欄の表示順)', () => {
  it('既定の同期設定の並び = 商品表示順(ひのドッグ→やきそば→麦茶→サイダー→カルピス→りんご→ゲーム)', () => {
    expect(productOrderKeys(DEFAULT_SYNC_SETTINGS.includeColumns, DEFAULT_SYNC_SETTINGS.rename)).toEqual([
      'ひのドッグ(個数)',
      'やきそば(個数)',
      '麦茶(個数)',
      'サイダー(個数)',
      'カルピス(個数)',
      'りんご(個数)',
      'ゲーム(個数)',
    ])
  })

  it('includeColumns の行順がそのまま表示順になる(商品を並び替えられる)', () => {
    expect(
      productOrderKeys(['ゲーム(個数)', '麦茶(個数)', 'ひのドッグ(個数)'], {}),
    ).toEqual(['ゲーム(個数)', '麦茶(個数)', 'ひのドッグ(個数)'])
  })

  it('個数系以外のカラムは順から落ち、rename はキー名に反映される', () => {
    expect(
      productOrderKeys(['氏名', 'やきそば(個数)', '領収書が必要な方はチェックをお願いします。'], {
        '領収書が必要な方はチェックをお願いします。': '領収書',
        '犬(個数)': 'ひのドッグ(個数)',
      }),
    ).toEqual(['やきそば(個数)'])
    // rename 後のキーが個数系なら順に載る
    expect(productOrderKeys(['犬(個数)', '麦茶(個数)'], { '犬(個数)': 'ひのドッグ(個数)' })).toEqual([
      'ひのドッグ(個数)',
      '麦茶(個数)',
    ])
  })

  it('全角括弧の suffix も個数系として扱い、重複は最初のみ残す', () => {
    expect(isQuantityKey('麦茶（個数）')).toBe(true)
    expect(isQuantityKey('麦茶')).toBe(false)
    expect(productOrderKeys(['麦茶（個数)', '麦茶（個数）', '麦茶（個数）'], {})).toEqual(['麦茶（個数）'])
  })

  it('商品名取り出し: suffix を除く/括弧无はそのまま/suffix のみのキーはキー名のまま', () => {
    expect(quantityName('ひのドッグ(個数)')).toBe('ひのドッグ')
    expect(quantityName('りんご（個数）')).toBe('りんご')
    expect(quantityName('備考')).toBe('備考')
    expect(quantityName('(個数)')).toBe('(個数)')
  })

  it('空の includeColumns は順未指定(空配列。呼ぶ側がフォールバックの並びを使う)', () => {
    expect(productOrderKeys([], {})).toEqual([])
  })
})

describe('escapePayloadKey / payloadTextColumn(キー名に " が混ざってもパスを守る)', () => {
  it('キー内の " は二重にして引用の終端にしない', () => {
    expect(escapePayloadKey('a"b')).toBe('a""b')
    expect(payloadTextColumn('a"b')).toBe('payload->>"a""b"')
    // 通常のキー名は変化しない(既存の照会式と同じ形)
    expect(payloadTextColumn('氏名')).toBe('payload->>"氏名"')
  })
})

describe('keyAbsentConditions(任意キーの「なし」論理木)', () => {
  it('任意のキー名で欠落(null)と空文字の両方を包含する', () => {
    expect(keyAbsentConditions('ボランティア')).toBe(
      'payload->>"ボランティア".is.null,payload->>"ボランティア".eq.""',
    )
  })

  it('remarkAbsentConditions はキー既定版(備考キー指定と同じ論理木)', () => {
    expect(remarkAbsentConditions()).toBe(keyAbsentConditions('備考'))
  })
})

describe('parseKeyFilter(汎用キー絞り込み spec のパース)', () => {
  it('有無は値不要。キー・モードの空白と大文字は吸収する', () => {
    expect(parseKeyFilter('ボランティア|present')).toEqual({ key: 'ボランティア', mode: 'present', value: '', values: [] })
    expect(parseKeyFilter(' ボランティア | ABSENT ')).toEqual({ key: 'ボランティア', mode: 'absent', value: '', values: [] })
    // 有無に値が付いても無視する(条件は有無だけ)
    expect(parseKeyFilter('備考|present|x')).toEqual({ key: '備考', mode: 'present', value: '', values: [] })
  })

  it('contains は残り部分を値として読む(| が混ざっても再結合してそのまま一致対象)', () => {
    expect(parseKeyFilter('入金状況|contains|%50|円%')).toEqual({
      key: '入金状況',
      mode: 'contains',
      value: '%50|円%',
      values: [],
    })
    expect(parseKeyFilter('入金状況|contains|')).toBeNull() // 空値は条件なし
    expect(parseKeyFilter('入金状況|contains|   ')).toBeNull() // 空白のみも条件なし
  })

  it('in は | 区切りの値選択(同一キー内 OR。重複・空は normalizeSelection と同じ)', () => {
    expect(parseKeyFilter('支払い方法|in|振り込み|現金')).toEqual({
      key: '支払い方法',
      mode: 'in',
      value: '',
      values: ['振り込み', '現金'],
    })
    expect(parseKeyFilter('支払い方法|in|現金|現金')).toEqual({
      key: '支払い方法',
      mode: 'in',
      value: '',
      values: ['現金'],
    })
    expect(parseKeyFilter('支払い方法|in|')).toBeNull()
  })

  it('認識できないモード・区切り無し・空キー・非文字列は null(条件にしない)', () => {
    expect(parseKeyFilter('ボランティア')).toBeNull()
    expect(parseKeyFilter('ボランティア|yes')).toBeNull()
    expect(parseKeyFilter('|present')).toBeNull()
    expect(parseKeyFilter(undefined)).toBeNull()
    expect(parseKeyFilter(123)).toBeNull()
  })

  it('長さ上限超過のキーは条件にしない(切り捨てると別の実キーのprefixに化ける)', () => {
    expect(parseKeyFilter(`${'a'.repeat(KEY_NAME_MAX_LENGTH + 5)}|present`)).toBeNull()
  })

  it('キー名に " が混ざるキーは条件にしない(表示のみ。PostgREST/supabase-js の照会が安全に組めない)', () => {
    expect(parseKeyFilter('特"殊キー|present')).toBeNull()
    expect(parseKeyFilter('特"殊キー|contains|x')).toBeNull()
  })
})

describe('isFilterableKey(検索できるキーの判定)', () => {
  it('通常のキーは true。" 含む・長さ上限超過・空は false(表示のみ)', () => {
    expect(isFilterableKey('ボランティア')).toBe(true)
    expect(isFilterableKey('ひのドッグ(個数)')).toBe(true)
    expect(isFilterableKey('特"殊キー')).toBe(false)
    expect(isFilterableKey('')).toBe(false)
    expect(isFilterableKey('a'.repeat(KEY_NAME_MAX_LENGTH))).toBe(true)
    expect(isFilterableKey('a'.repeat(KEY_NAME_MAX_LENGTH + 1))).toBe(false)
  })
})

describe('normalizeKeyFilters(参数の受け取り・重複除き・上限)', () => {
  it('配列は各要素を spec そのまま、文字列はカンマ区切りで分割する', () => {
    expect(normalizeKeyFilters(['ボランティア|present', '支払い方法|in|現金'])).toEqual([
      { key: 'ボランティア', mode: 'present', value: '', values: [] },
      { key: '支払い方法', mode: 'in', value: '', values: ['現金'] },
    ])
    expect(normalizeKeyFilters('ボランティア|absent,備考|contains|振込')).toEqual([
      { key: 'ボランティア', mode: 'absent', value: '', values: [] },
      { key: '備考', mode: 'contains', value: '振込', values: [] },
    ])
  })

  it('同一キー同一モードの重複は最初のみ。異モードの同時指定は残す(AND で交わる)', () => {
    expect(normalizeKeyFilters(['備考|contains|a', '備考|contains|b'])).toEqual([
      { key: '備考', mode: 'contains', value: 'a', values: [] },
    ])
    expect(normalizeKeyFilters(['備考|contains|a', '備考|present'])).toHaveLength(2)
  })

  it('壊れた要素は捨てて残りの条件を使う(配列要素の contains 値の , は壊れない)', () => {
    expect(normalizeKeyFilters(['junk', '入金状況|contains|50,000円'])).toEqual([
      { key: '入金状況', mode: 'contains', value: '50,000円', values: [] },
    ])
    expect(normalizeKeyFilters(undefined)).toEqual([])
    expect(normalizeKeyFilters('bad')).toEqual([])
    expect(normalizeKeyFilters([123])).toEqual([])
  })

  it('条件数の上限(KEY_FILTER_MAX)で切る(論理木の膨張を防ぐ)', () => {
    const specs = Array.from({ length: KEY_FILTER_MAX + 3 }, (_, i) => `キー${i}|present`)
    expect(normalizeKeyFilters(specs)).toHaveLength(KEY_FILTER_MAX)
  })
})

describe('serializeKeyFilters / sameKeyFilters(URL 参数・条件比較)', () => {
  it('spec 文字列に戻す(in の値は | 区切り、contains の値はそのまま)', () => {
    expect(
      serializeKeyFilters([
        { key: 'ボランティア', mode: 'absent', value: '', values: [] },
        { key: '備考', mode: 'contains', value: '振込', values: [] },
        { key: '支払い方法', mode: 'in', value: '', values: ['現金', '振り込み'] },
      ]),
    ).toEqual(['ボランティア|absent', '備考|contains|振込', '支払い方法|in|現金|振り込み'])
  })

  it('round trip: serialize → normalize で同じ条件になる', () => {
    const filters = normalizeKeyFilters(['ボランティア|present', '入金状況|contains|100%'])
    expect(normalizeKeyFilters(serializeKeyFilters(filters))).toEqual(filters)
  })

  it('sameKeyFilters は順序無視の集合比較(条件の送信順を変えても同じ条件)', () => {
    const a = normalizeKeyFilters(['ボランティア|present', '備考|contains|振込'])
    const b = normalizeKeyFilters(['備考|contains|振込', 'ボランティア|present'])
    expect(sameKeyFilters(a, b)).toBe(true)
    expect(sameKeyFilters(a, normalizeKeyFilters(['ボランティア|absent']))).toBe(false)
    expect(sameKeyFilters([], [])).toBe(true)
  })
})
