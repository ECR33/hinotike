/**
 * 任意項目(payload キー)の絞り込み(有無・部分一致・値選択)の PostgREST 挙動を
 * ローカル Supabase で確認する統合テスト。server/api/items-list.get.ts が組むフィルタと同じ
 * 組み立てを shared/utils/items のヘルパーから再現する(ボランティア欄のような任意キーを想定)。
 *
 * 前提: `supabase start` と schema.sql/migrations 適用済み。env がなければ自動スキップ(CI でローカル Supabase が無くても npm test は通る)。
 * 実行: SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY を env に与えて npm test(test:local)。
 *
 * 確認したい挙動:
 *  - present = not.is.null + neq "" → 空文字は「なし」側へ出る(空白のみの値は「あり」側。照合側で trim できない)
 *  - absent = or=(is.null, eq "") → キーの欠落と空文字の両方を含む
 *  - absent の `or=` はキーごとに別パラメータなので複数 absent・pairs の or と AND で交わる
 *  - contains(ilike)は任意キーを照会でき、入力の % _ はリテラル(containsPattern)
 *  - in() は同一キー内の値選択 OR(特殊文字は quoteInValue で守る)
 *  - キー名に `"` が混ざるキーは supabase-js の絞り込みが安全に組めない(パス照会は黙って 0 件、
 *    `.or()` の論理木はパースエラー)→ parseKeyFilter は这类のキーを条件にせず、UI は表示のみにする
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  containsPattern,
  keyAbsentConditions,
  normalizeKeyFilters,
  pairConditions,
  payloadTextColumn,
  quoteInValue,
} from '../../shared/utils/items'

const URL = process.env.SUPABASE_URL ?? 'http://localhost:54321'
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.NUXT_SUPABASE_SERVICE_ROLE ?? ''

const describeFlow = describe.skipIf(!SECRET_KEY)

const VOLUNTEER = payloadTextColumn('ボランティア')
const RECEIPT = payloadTextColumn('領収書')
const PAYMENT = payloadTextColumn('支払い方法')
const DEPOSIT = payloadTextColumn('入金状況')
const YEAR = payloadTextColumn('学年')
const GROUP = payloadTextColumn('クラス')
// キー名に " が混ざる行(シートヘッダー由来の任意キー名を想定。引用パスが壊れないことを確認する)
const QUOTE_KEY = payloadTextColumn('特"殊キー')

const PREFIX = 'key-filter-test-'
const rows = [
  { code: `${PREFIX}v-yes`, payload: { 学年: '1', クラス: '3', 氏名: 'ボランティアあり', ボランティア: 'yes' } },
  { code: `${PREFIX}v-none`, payload: { 学年: '1', クラス: '3', 氏名: 'キー欠落' } },
  { code: `${PREFIX}v-empty`, payload: { 学年: '1', クラス: '3', 氏名: '空文字', ボランティア: '' } },
  { code: `${PREFIX}v-blank`, payload: { 学年: '1', クラス: '3', 氏名: '空白のみ', ボランティア: '   ' } },
  { code: `${PREFIX}v-p2`, payload: { 学年: '2', クラス: '1', 氏名: '別ペア', ボランティア: 'yes' } },
  { code: `${PREFIX}pay-cash`, payload: { 学年: '1', クラス: '3', 氏名: '現金', 支払い方法: '現金' } },
  { code: `${PREFIX}pay-transfer`, payload: { 学年: '1', クラス: '3', 氏名: '振り込み', 支払い方法: '振り込み' } },
  { code: `${PREFIX}pay-other`, payload: { 学年: '1', クラス: '3', 氏名: '未入金', 入金状況: '未入金100%相違' } },
  { code: `${PREFIX}quote`, payload: { 学年: '1', クラス: '3', 氏名: '引用キー', '特"殊キー': 'x' } },
]

let admin: SupabaseClient

/** プローブ行(code が PREFIX で始まる分)だけを条件付きで読み、code の集合を返す。 */
async function codesUnder(build: (builder: ReturnType<typeof admin.from>) => ReturnType<typeof admin.from>): Promise<string[]> {
  let builder = admin.from('items').select('code').like('code', `${PREFIX}%`)
  builder = build(builder)
  const { data, error } = await builder
  expect(error).toBeNull()
  return ((data ?? []) as { code: string }[]).map((row) => row.code).sort()
}

describeFlow('items の任意項目フィルタ(PostgREST の has-null / ilike / in / or / 引用キー)', () => {
  beforeAll(async () => {
    admin = createClient(URL, SECRET_KEY)
    await admin.from('items').delete().like('code', `${PREFIX}%`)
    const { error } = await admin.from('items').insert(rows)
    expect(error).toBeNull()
  })

  afterAll(async () => {
    await admin.from('items').delete().like('code', `${PREFIX}%`)
  })

  it('あり(present)は値がある行だけ(空文字は除外、空白のみは含む)', async () => {
    const codes = await codesUnder((b) => b.not(VOLUNTEER, 'is.null', null).neq(VOLUNTEER, ''))
    expect(codes).toEqual([`${PREFIX}v-blank`, `${PREFIX}v-p2`, `${PREFIX}v-yes`])
  })

  it('なし(absent)はキーの欠落と空文字の両方(or で2つを並べる)', async () => {
    const codes = await codesUnder((b) => b.or(keyAbsentConditions('ボランティア')))
    expect(codes).toEqual([`${PREFIX}pay-cash`, `${PREFIX}pay-other`, `${PREFIX}pay-transfer`, `${PREFIX}quote`, `${PREFIX}v-empty`, `${PREFIX}v-none`])
  })

  it('absent を2キー重ねると別 or= として AND で交わる(ボランティアなし + 領収書なし)', async () => {
    const codes = await codesUnder((b) =>
      b.or(keyAbsentConditions('ボランティア')).or(keyAbsentConditions('領収書')),
    )
    // ボランティアの値のある行(v-yes/v-p2/v-blank)は「ボランティアなし」で落ち、残り6行(混ざらない確認)
    expect(codes).toEqual([
      `${PREFIX}pay-cash`,
      `${PREFIX}pay-other`,
      `${PREFIX}pay-transfer`,
      `${PREFIX}quote`,
      `${PREFIX}v-empty`,
      `${PREFIX}v-none`,
    ])
  })

  it('なしの or にペア指定の or を重ねると AND で交わる(別の or= なので混ざらない)', async () => {
    const codes = await codesUnder((b) =>
      b.or(keyAbsentConditions('ボランティア')).or(pairConditions([{ year: '1', group: '3' }])),
    )
    expect(codes).toEqual([`${PREFIX}pay-cash`, `${PREFIX}pay-other`, `${PREFIX}pay-transfer`, `${PREFIX}quote`, `${PREFIX}v-empty`, `${PREFIX}v-none`])
  })

  it('部分一致(ilike)は任意キーを照会でき、入力の % はリテラルに扱う', async () => {
    expect(await codesUnder((b) => b.ilike(DEPOSIT, containsPattern('未入金')!))).toEqual([`${PREFIX}pay-other`])
    expect(await codesUnder((b) => b.ilike(DEPOSIT, containsPattern('100%')!))).toEqual([`${PREFIX}pay-other`])
  })

  it('in() は同一キー内の値選択 OR(複数値はカンマ区切り・引用で守る)', async () => {
    const codes = await codesUnder((b) => b.in(PAYMENT, ['現金', '振り込み'].map(quoteInValue)))
    expect(codes).toEqual([`${PREFIX}pay-cash`, `${PREFIX}pay-transfer`])
  })

  it('present と contains の同時指定は AND(キー欠落行は残らない)', async () => {
    expect(
      await codesUnder((b) => b.not(VOLUNTEER, 'is.null', null).neq(VOLUNTEER, '').ilike(VOLUNTEER, '%yes%')),
    ).toEqual([`${PREFIX}v-p2`, `${PREFIX}v-yes`])
    expect(await codesUnder((b) => b.or(keyAbsentConditions('ボランティア')).ilike(VOLUNTEER, '%yes%'))).toEqual([])
  })

  it('キー名に " が混ざると supabase-js の絞り込みは安全に組めない(→ 検索不可・表示のみで扱う)', async () => {
    // 引用エスケープしたパスでも行は存在するが、照会は黙って 0 件になる(supabase-js の encoded name が壊れる)
    expect(QUOTE_KEY).toBe('payload->>"特""殊キー"')
    expect(await codesUnder((b) => b.not(QUOTE_KEY, 'is.null', null))).toEqual([])
    // `.or()` の論理木はパースエラー(failed to parse logic tree)になる
    const { data, error } = await admin
      .from('items')
      .select('code')
      .like('code', `${PREFIX}%`)
      .or(keyAbsentConditions('特"殊キー'))
    expect(error).not.toBeNull()
    expect(data).toBeNull()
    // parseKeyFilter/normalizeKeyFilters は这类のキーを条件にしない(items-list に送られない)
    expect(normalizeKeyFilters(['特"殊キー|present', '特"殊キー|absent'])).toEqual([])
  })

  it('欠落キーの present は 0 件、同キーの absent は該当行(キー単位の独立)', async () => {
    expect(await codesUnder((b) => b.not(payloadTextColumn('不存在キー'), 'is.null', null).neq(payloadTextColumn('不存在キー'), ''))).toEqual([])
    expect(await codesUnder((b) => b.or(keyAbsentConditions('不存在キー')))).toEqual(rows.map((row) => row.code).sort())
  })
})
