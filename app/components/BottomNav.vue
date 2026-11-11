<script setup lang="ts">
import type { MeState } from '#shared/utils/auth'

/**
 * 常駐の bottom navigation(app.vue から全ページで表示)。
 *
 * 遷移先は状態によって出す:
 *  - 未認証   … トップ / ログイン(保護ページはミドルウェアが /login?returnTo= に誘導するので出さない)
 *  - 認証済み・未登録 … トップ / 許可依頼(/unauthorized) / ログアウト
 *  - 認証済み・許可済み … トップ / QRスキャン / 一覧(/items) / 利用者登録 / ログアウト
 * ログアウトはルートではなく action(/api/logout)。
 *
 * 認証状態はミドルウェアと同じ useState('auth-state') を読む。app.vue の render は
 * ミドルウェア(NuxtPage の setup)より先に走るため、SSR で未缓存のときはここで解決して
 * 缓存に入れる(ミドルウェア・ページは同じ缓存を読むので /api/me の重複照会にならない)。
 * 失敗時は throw したままにする(従来と同じくエラーページになる。握りつぶして
 * 「未認証」扱いにすると 500 がログイン誘導に化ける)。
 */
const route = useRoute()
const { logout } = useLogout()
const authState = useState<MeState | null>('auth-state', () => null)

if (authState.value === null) {
  authState.value = await $fetch<MeState>('/api/me', { headers: useRequestHeaders(['cookie']) })
}

// stroke で描く 24x24 のインラインアイコン(dep を増やさないため SVG を直書き)。
const ICONS = {
  home: 'M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z M9.5 20v-4.5h5V20',
  scan: 'M4 9V6a2 2 0 0 1 2-2h3 M15 4h3a2 2 0 0 1 2 2v3 M20 15v3a2 2 0 0 1-2 2h-3 M9 20H6a2 2 0 0 1-2-2v-3 M3 12h18',
  register: 'M12 5.5 19 8v5c0 4-3 6.6-7 8.5-4-1.9-7-4.5-7-8.5V8z M9.4 12.4l2.2 2.2 4.2-4.2',
  login: 'M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4 M3 12h12 M10 8.5 13.5 12 10 15.5',
  logout: 'M9 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H10',
  request: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11.5v5 M12 7.5h.01',
  // 一覧: 左に点、右に線の行を積んだリスト表記
  list: 'M4.5 6h.01 M4.5 12h.01 M4.5 18h.01 M8.5 6h11.5 M8.5 12h11.5 M8.5 18h11.5',
  // 同期: 循環する矢印(Sheets → items の取り込み)
  sync: 'M4.5 9a8 8 0 0 1 12.5-3.5 M19.5 15a8 8 0 0 1-12.5 3.5 M17.5 3v3h-3 M6.5 21v-3h3',
} as const

interface NavItem {
  key: string
  label: string
  icon: keyof typeof ICONS
  /** ルートリンク。未設定なら action ボタン(logout) */
  to?: string
  action?: 'logout'
  /** ハイライト対象のパス(結果画面はスキャンの延長なので scan を光らせる) */
  activePaths?: string[]
}

const items = computed<NavItem[]>(() => {
  const home: NavItem = { key: 'home', label: 'トップ', icon: 'home', to: '/' }
  const logoutItem: NavItem = { key: 'logout', label: 'ログアウト', icon: 'logout', action: 'logout' }

  const me = authState.value
  if (!me || !me.authenticated) {
    return [home, { key: 'login', label: 'ログイン', icon: 'login', to: '/login' }]
  }
  if (!me.authorized) {
    return [home, { key: 'request', label: '許可依頼', icon: 'request', to: '/unauthorized' }, logoutItem]
  }
  return [
    home,
    { key: 'scan', label: 'QRスキャン', icon: 'scan', to: '/scan', activePaths: ['/scan', '/result'] },
    { key: 'items', label: '一覧', icon: 'list', to: '/items' },
    { key: 'register', label: '利用者登録', icon: 'register', to: '/register' },
    // 管理者運用: Spreadsheet → items の同期(/sync)。登録済みユーザなら実行できる。
    { key: 'sync', label: '同期', icon: 'sync', to: '/sync' },
    logoutItem,
  ]
})

function isActive(item: NavItem): boolean {
  if (!item.to) return false
  return (item.activePaths ?? [item.to]).includes(route.path)
}
</script>

<template>
  <nav class="bottom-nav" aria-label="ページ遷移">
    <div class="nav-row">
      <template v-for="item in items" :key="item.key">
        <button
          v-if="item.action === 'logout'"
          class="nav-item"
          type="button"
          @click="logout"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path :d="ICONS[item.icon]" />
          </svg>
          <span>{{ item.label }}</span>
        </button>
        <NuxtLink
          v-else
          class="nav-item"
          :to="item.to"
          :class="{ active: isActive(item) }"
          :aria-current="isActive(item) ? 'page' : undefined"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path :d="ICONS[item.icon]" />
          </svg>
          <span>{{ item.label }}</span>
        </NuxtLink>
      </template>
    </div>
  </nav>
</template>

<style scoped>
.bottom-nav {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  background: rgba(15, 23, 42, 0.92);
  border-top: 1px solid #334155;
  /* ノッチ/ホームバーの安全領域ぶんは確保する(viewport-fit=cover のブラウザ対策) */
  padding-bottom: env(safe-area-inset-bottom);
  backdrop-filter: blur(8px);
}

/* .page と同じ最大幅に揃えて中央に置く(広い画面では全幅にしない) */
.nav-row {
  max-width: 640px;
  margin-inline: auto;
  display: flex;
  gap: 4px;
  padding: 6px 8px;
}

.nav-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 4px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.nav-item svg {
  width: 22px;
  height: 22px;
}

.nav-item.active {
  color: var(--accent);
  background: rgba(56, 189, 248, 0.12);
}
</style>
