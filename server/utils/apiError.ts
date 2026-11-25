import type { ApiErrorPayload } from '#shared/utils/apiError'

/**
 * API の失敗を「理由コード + 日本語の案内」で投げる(helper)。
 *
 * `statusMessage` には **ASCII の理由コード** だけを載せる(HTTP の status line は printable
 * ASCII 限定で、h3 の `sanitizeStatusMessage` が日本語を落とすため。案内を statusMessage に
 * 載せると画面側は `400 "" ID ()` のような欠損文字列を見る)。
 * 日本語の案内は `message`(JSON body の `message`)、画面の文言決定に使う構造は `data`
 * (JSON body の `data`)に載せる。画面側は `shared/utils/apiError.ts` の `describeApiError` で読む。
 * `createError` は nitro の auto-import(server/utils なので import 不要)。
 */
export function apiFailure(statusCode: number, payload: ApiErrorPayload, message: string) {
  return createError({
    statusCode,
    statusMessage: payload.reason,
    message,
    data: payload,
  })
}
