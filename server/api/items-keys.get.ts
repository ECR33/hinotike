import { configuredPayloadKeys, datasetKeys } from '#shared/utils/offline'
import type { ItemsKeysResponse } from '#shared/utils/items'
import { datasetFromSource, resolveSource } from '../utils/dataset'

/**
 * 一覧の「任意項目」絞り込み・表示のための**payload キーの発見**(シート由来)。
 *
 * 前提: Google 認証済み + users テーブルへの紐付け(items-list / items-facets と同じ requireRegisteredUser)。
 * 対象シートは ?sourceId=(未指定は有効な最初のデータセット)。
 *
 * 導出は **shared の datasetKeys**(端末ミラーの keys と同じ実装)。2つの源の和集合を返す:
 *  - **定義から**: データセットの includeColumns を rename 適用後のキーに写した「載る予定のキー」
 *    (includeColumns が空のときは rename の新キー名だけ。全カラム取り込みでは実データ側で出る)。
 *  - **実データから**: シート由来の行の payload に実際に出現したキー。
 * 定義に載る予定だがまだ出現していないキーは seenInData=false で出す(画面は消さずに注記する)。
 * codeColumn は payload に載らないので候補から除く(configuredPayloadKeys が除く)。
 */
export default defineEventHandler(async (event): Promise<ItemsKeysResponse & { sourceId: number; sheetTitle: string }> => {
  await requireRegisteredUser(event)

  const source = await resolveSource(event, getQuery(event).sourceId)
  const dataset = await datasetFromSource(event, source)

  return {
    ...datasetKeys(dataset.rows, configuredPayloadKeys(source)),
    sourceId: source.id ?? 0,
    sheetTitle: dataset.sheetTitle,
  }
})
