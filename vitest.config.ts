import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    // server/utils のモジュールは Nuxt/nitro の `#shared` alias を使うのでテストでも同じ解決をする
    // (Google 鍵の読み取りの単体テストが server/utils/googleSheets.ts を import する)。
    alias: { '#shared': new URL('./shared', import.meta.url).pathname },
  },
})
