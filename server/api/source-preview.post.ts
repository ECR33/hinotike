import { readBody } from 'h3'
import { payloadKeysOf, MAX_IMPORT_ROWS, type SourcePreviewResponse } from '#shared/utils/sync'
import { readServiceAccountKey } from '../utils/googleSheets'
import { datasetFromSource, requireSource } from '../utils/dataset'

/**
 * 1データセットの**取り込み前プレビュー**(シートを読み、選別結果を見せる。書き込まない)。
 * 登録済みユーザのみ。シート読み取りの失敗は ok:false + error で返す(API を落とさない =
 * 設定画面が「このシートは読めません」を出せるようにする)。
 *
 * 見せるもの: 実際のワークシート名(設定の worksheet 不一致の案内)・ヘッダー・取り込み対象カラム・
 * payload に載るキー・行数・code 空スキップ・行フィルタ除外・上限打ち切り・先頭サンプル。
 */
export default defineEventHandler(async (event): Promise<SourcePreviewResponse> => {
  await requireRegisteredUser(event)

  const body = await readBody<{ sourceId?: unknown }>(event)
  const source = await requireSource(event, body?.sourceId)

  const base: SourcePreviewResponse = {
    sourceId: source.id ?? 0,
    ok: false,
    error: null,
    sheetTitle: null,
    worksheetMatched: true,
    sheetTitles: [],
    headers: null,
    columns: [],
    payloadKeys: [],
    dataRows: 0,
    rowCount: 0,
    skipped: 0,
    filtered: 0,
    codeColumnMissing: false,
    filterColumnMissing: false,
    truncated: false,
    sample: [],
  }

  if (!(await readServiceAccountKey())) {
    return { ...base, error: 'GOOGLE_SERVICE_ACCOUNT_JSON が未設定です(Worker の secret に設定)' }
  }
  if (!source.spreadsheetId) {
    return { ...base, error: `データセット "${source.name}" のスプレッドシート ID が未設定です` }
  }

  try {
    const dataset = await datasetFromSource(event, source)
    const mapping = dataset.index.mapping
    return {
      ...base,
      ok: true,
      sheetTitle: dataset.sheetTitle,
      worksheetMatched: !source.worksheet || dataset.index.titles.includes(source.worksheet),
      sheetTitles: dataset.index.titles,
      headers: mapping.headers,
      columns: mapping.columns,
      payloadKeys: payloadKeysOf(dataset.rows),
      // mapping.rows は上限前の全行を含まない(dataset.rows は MAX_IMPORT_ROWS で切る)。dataRows はシート実測の行数
      dataRows: dataset.rows.length + dataset.skipped + dataset.filtered,
      rowCount: dataset.rows.length,
      skipped: dataset.skipped,
      filtered: dataset.filtered,
      codeColumnMissing: mapping.codeColumnMissing,
      filterColumnMissing: mapping.filterColumnMissing,
      truncated: dataset.truncated || mapping.rows.length > MAX_IMPORT_ROWS,
      sample: dataset.rows.slice(0, 5),
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    const data = (e as { data?: { columns?: string[] } })?.data
    return {
      ...base,
      error: data?.columns?.length ? `code カラム "${data.columns.join(', ')}" がヘッダーにありません` : message,
      codeColumnMissing: !!data?.columns?.length || !!source.codeColumn,
    }
  }
})