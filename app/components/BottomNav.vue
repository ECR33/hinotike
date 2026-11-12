<script setup lang="ts">
import type { MeState } from '#shared/utils/auth'

/**
 * 常駐の bottom navigation(app.vue から全ページで表示)。
 *
 * 遷移先は状態によって出す:
 *  - 未認証   … トップ / ログイン(保護ページはミドルウェアが /login?returnTo= に誘導するので出さない)
 *  - 認証済み・未登録 … トップ / 許可依頼(/unauthorized) / 管理(ログアウト)
 *  - 認証済み・許可済み … トップ / QRスキャン / 一覧(/items) / 管理(dropdown menu)
 * 管理系(アプリ共有・利用者登録・同期・ログアウト)は「管理」ボタン の dropdown menu にまとめて
 * 常駐バーの項目数を抑える。許可依頼は未登録ユーザの主動作なのでバーに直接残す。
 * ログアウトはルートではなく action(/api/logout)。
 *
 * dropdown はバーの上に開く。外側クリック / Escape / ルート変更で閉じる
 * (document リスナーは onMounted のみ — SSR では document が無い)。
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
  // 共有: 3つの点 を線で結んだ share 表記(アプリリンクのQRを他のスマホへ)
  share: 'M8.7 12a2.2 2.2 0 1 0-4.4 0 2.2 2.2 0 0 0 4.4 0 M19.7 6a2.2 2.2 0 1 0-4.4 0 2.2 2.2 0 0 0 4.4 0 M19.7 18a2.2 2.2 0 1 0-4.4 0 2.2 2.2 0 0 0 4.4 0 M8.5 11.2 15.6 7.1 M8.5 12.8 15.6 16.9',
  // 管理: 横3点(ellipsis)。dropdown のトリガー
  menu: 'M5 12h.01 M12 12h.01 M19 12h.01',
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

interface ManageItem extends NavItem {
  /** dropdown menu に格納する項目(dropdown 自体は遷移しない) */
  children: NavItem[]
}

const items = computed<(NavItem | ManageItem)[]>(() => {
  const home: NavItem = { key: 'home', label: 'トップ', icon: 'home', to: '/' }
  const logoutItem: NavItem = { key: 'logout', label: 'ログアウト', icon: 'logout', action: 'logout' }

  const me = authState.value
  if (!me || !me.authenticated) {
    return [home, { key: 'login', label: 'ログイン', icon: 'login', to: '/login' }]
  }
  // 未登録: 主動作(許可依頼)はバーに残し、ログアウトだけ dropdown に格納する。
  if (!me.authorized) {
    return [
      home,
      { key: 'request', label: '許可依頼', icon: 'request', to: '/unauthorized' },
      { key: 'manage', label: '管理', icon: 'menu', children: [logoutItem] },
    ]
  }
  return [
    home,
    { key: 'scan', label: 'QRスキャン', icon: 'scan', to: '/scan', activePaths: ['/scan', '/result'] },
    { key: 'items', label: '一覧', icon: 'list', to: '/items' },
    // 管理系: アプリ共有(/share)・利用者登録(/register)・同期(/sync)・ログアウト
    {
      key: 'manage',
      label: '管理',
      icon: 'menu',
      activePaths: ['/share', '/register', '/sync'],
      children: [
        { key: 'share', label: 'アプリ共有', icon: 'share', to: '/share' },
        { key: 'register', label: '利用者登録', icon: 'register', to: '/register' },
        { key: 'sync', label: '同期', icon: 'sync', to: '/sync' },
        logoutItem,
      ],
    },
  ]
})

function isActive(item: NavItem): boolean {
  // dropdown トリガー(manage)は to を持たないが activePaths で点灯する
  const paths = item.activePaths ?? (item.to ? [item.to] : [])
  return paths.includes(route.path)
}

function isManage(item: NavItem | ManageItem): item is ManageItem {
  return Array.isArray((item as ManageItem).children)
}

// dropdown menu の開閉。既定は閉じる(SSR と client 初回描画を一致させる)。
const menuOpen = ref(false)
function closeMenu() {
  menuOpen.value = false
}
function toggleMenu() {
  menuOpen.value = !menuOpen.value
}
function onDocClick(e: MouseEvent) {
  if (!menuOpen.value) return
  if (!(e.target as HTMLElement).closest('.nav-manage')) closeMenu()
}
function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeMenu()
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onDocKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onDocKeydown)
})
// リンク選択後は route 変化で閉じる。ログアウトは route が変わらないので自分で閉じる。
watch(() => route.path, closeMenu)
async function logoutFromMenu() {
  closeMenu()
  await logout()
}
</script>

<template>
  <nav class="bottom-nav" aria-label="ページ遷移">
    <div class="nav-row">
      <template v-for="item in items" :key="item.key">
        <!-- dropdown menu トリガー(管理系項目をまとめて格納) -->
        <div v-if="isManage(item)" class="nav-manage" :class="{ active: isActive(item) }">
          <button
            class="nav-item"
            type="button"
            :aria-expanded="menuOpen"
            aria-haspopup="true"
            @click="toggleMenu"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path :d="ICONS[item.icon]" />
            </svg>
            <span>{{ item.label }}</span>
          </button>
          <div v-if="menuOpen" class="nav-menu" role="menu">
            <template v-for="child in item.children" :key="child.key">
              <button
                v-if="child.action === 'logout'"
                class="menu-item danger"
                type="button"
                role="menuitem"
                @click="logoutFromMenu"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path :d="ICONS[child.icon]" />
                </svg>
                <span>{{ child.label }}</span>
              </button>
              <NuxtLink
                v-else
                class="menu-item"
                role="menuitem"
                :to="child.to"
                :class="{ active: isActive(child) }"
                :aria-current="isActive(child) ? 'page' : undefined"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path :d="ICONS[child.icon]" />
                </svg>
                <span>{{ child.label }}</span>
              </NuxtLink>
            </template>
          </div>
        </div>
        <button
          v-else-if="item.action === 'logout'"
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

/* dropdown トリガー(.nav-manage.active の子ボタンを光らせる) */
.nav-manage {
  position: relative;
  flex: 1;
}

.nav-manage.active .nav-item {
  color: var(--accent);
  background: rgba(56, 189, 248, 0.12);
}

/* バーの上に開くメニュー(右端トリガーなので右揃えで配置し、行からはみ出さない) */
.nav-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  min-width: 168px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  background: rgba(15, 23, 42, 0.98);
  border: 1px solid #334155;
  border-radius: 12px;
  box-shadow: 0 -6px 18px rgba(0, 0, 0, 0.45);
  z-index: 40;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font-size: 14px;
  text-decoration: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.menu-item svg {
  width: 18px;
  height: 18px;
  color: var(--muted);
}

.menu-item:hover {
  background: rgba(56, 189, 248, 0.12);
}

.menu-item.active {
  color: var(--accent);
}

.menu-item.danger {
  color: var(--danger);
}

.menu-item.danger svg {
  color: var(--danger);
}
</style>
