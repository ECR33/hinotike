/**
 * 備考の絞り込み(有無・部分一致)の PostgREST 挙動をローカル Supabase で確認する統合テスト。
 * server/api/items-list.get.ts が組むフィルタと同じ組み立てを shared/utils/items のヘルパーから再現する。
 *
 * 前提: `supabase start` と schema.sql 適用済み。env がなければ自動スキップ(CI でローカル Supabase が無くても npm test は通る)。
 * 実行: SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY を env に与えて npm test。
 *
 * 確認したい挙動:
 *  - present = not.is.null + neq "" → 空文字は「なし」側へ出る(空白のみの備考は「あり」側。照合側で trim できない)
 *  - absent = or=(is.null, eq "") → 備考キーの欠落と空文字の両方を含む
 *  - absent の `or=` は pairs の `or=` と並べて AND になる(同じ列の論理木を混ぜない)
 *  - 備考の部分一致(ilike)は payload のキーを照会できる
 *  - 有無 + 文字検索は AND(「なし + 検索」は 0 件になる)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  ITEM_REMARK_KEY,
  pairConditions,
  payloadTextColumn,
  remarkAbsentConditions,
} from '../../shared/utils/items'

const URL = process.env.SUPABASE_URL ?? 'http://localhost:54321'
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.NUXT_SUPABASE_SERVICE_ROLE ?? ''

const describeFlow = describe.skipIf(!SECRET_KEY)

const REMARK = payloadTextColumn(ITEM_REMARK_KEY)
const PREFIX = 'remark-filter-test-'
const rows = [
  { code: `${PREFIX}text`, payload: { 学年: '1', クラス: '3', 氏名: '備考あり', 備考: '11/6 振込確認済み' } },
  { code: `${PREFIX}empty`, payload: { 学年: '1', クラス: '3', 氏名: '空文字', 備考: '' } },
  { code: `${PREFIX}blank`, payload: { 学年: '1', クラス: '3', 氏名: '空白のみ', 備考: '   ' } },
  { code: `${PREFIX}none`, payload: { 学年: '1', クラス: '3', 氏名: '備考なし' } },
  { code: `${PREFIX}other`, payload: { 学年: '2', クラス: '1', 氏名: '別ペア', 備考: '振込' } },
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

describeFlow('items の備考フィルタ(PostgREST の has-null / ilike / or)', () => {
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
    const codes = await codesUnder((b) => b.not(REMARK, 'is.null', null).neq(REMARK, ''))
    expect(codes).toEqual([`${PREFIX}blank`, `${PREFIX}other`, `${PREFIX}text`])
  })

  it('なし(absent)は備考キーの欠落と空文字の両方(or で2つを並べる)', async () => {
    const codes = await codesUnder((b) => b.or(remarkAbsentConditions()))
    expect(codes).toEqual([`${PREFIX}empty`, `${PREFIX}none`])
  })

  it('なしの or にペア指定の or を重ねると AND で交わる(別の or=なので混ざらない)', async () => {
    const codes = await codesUnder((b) =>
      b.or(remarkAbsentConditions()).or(pairConditions([{ year: '1', group: '3' }])),
    )
    expect(codes).toEqual([`${PREFIX}empty`, `${PREFIX}none`])
  })

  it('備考の部分一致(ilike)は payload のキーを照会できる', async () => {
    const codes = await codesUnder((b) => b.ilike(REMARK, '%振込%'))
    expect(codes).toEqual([`${PREFIX}other`, `${PREFIX}text`])
  })

  it('有無と文字検索の同時指定は AND(「なし+検索」は 0 件、「あり+検索」は検索結果)', async () => {
    expect(await codesUnder((b) => b.or(remarkAbsentConditions()).ilike(REMARK, '%振込%'))).toEqual([])
    expect(
      await codesUnder((b) => b.not(REMARK, 'is.null', null).neq(REMARK, '').ilike(REMARK, '%振込%')),
    ).toEqual([`${PREFIX}other`, `${PREFIX}text`])
  })
})
