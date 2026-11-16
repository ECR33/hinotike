import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCAN_MODES,
  SCAN_AUTO_FLUSH_COUNT,
  SCAN_CODES_MAX,
  SCAN_FLAG_VALUE,
  clampHistoryLimit,
  formatJst,
  historyNextCursor,
  isSameScan,
  modeColumns,
  modeColumnsMissing,
  modeColumnsOutsideInclude,
  normalizeScanDedupe,
  normalizeScanMode,
  normalizeScanModes,
  recordState,
  scanModeFromDb,
  scanModeSummary,
  scanModeToDb,
  scanStatusMessage,
  type ScanHistoryRow,
  type ScanMode,
} from '../../shared/utils/scan'

const baseMode: ScanMode = {
  id: 1,
  name: 'チェックイン',
  actions: [{ column: '来場済', columnAt: '来場日時', literal: SCAN_FLAG_VALUE, payloadKey: '来場済', payloadAtKey: '来場日時' }],
  dedupe: 'warn',
  confirmBeforeRecord: true,
  requireFound: true,
  enabled: true,
  updatedAt: null,
  updatedBy: null,
}

describe('normalizeScanMode(記録モードの正規化)', () => {
  it('空名・action 無しは null(黙って空モードを作らない)', () => {
    expect(normalizeScanMode({ name: '', actions: [] })).toBeNull()
    expect(normalizeScanMode({ name: '配布', actions: [] })).toBeNull()
    expect(normalizeScanMode(null)).toBeNull()
  })

  it('column だけなら payloadKey = column、columnAt は空、literal は既定の済', () => {
    const mode = normalizeScanMode({ name: '棚卸し', actions: [{ column: '棚卸済' }] })
    expect(mode?.actions).toEqual([{ column: '棚卸済', columnAt: '', literal: SCAN_FLAG_VALUE, payloadKey: '棚卸済', payloadAtKey: '' }])
    expect(mode?.confirmBeforeRecord).toBe(false)
    expect(mode?.requireFound).toBe(true)
  })

  it('payloadKey が空なら column にフォールバック(payload に載るキー名がシート名と一致)', () => {
    const mode = normalizeScanMode({
      name: '配布',
      actions: [{ column: '配布済', columnAt: '配布日時', payloadKey: '', payloadAtKey: '' }],
    })
    expect(mode?.actions[0]).toEqual({ column: '配布済', columnAt: '配布日時', literal: SCAN_FLAG_VALUE, payloadKey: '配布済', payloadAtKey: '配布日時' })
  })

  it('同名の column は除重し、上限(SCAN_ACTIONS_MAX)で切る', () => {
    const mode = normalizeScanMode({
      name: '多数',
      actions: [{ column: 'A' }, { column: 'A' }, { column: 'B' }, { column: 'C' }, { column: 'D' }],
    })
    expect(mode?.actions.map((a) => a.column)).toEqual(['A', 'B', 'C'])
  })

  it('dedupe は warn/skip/allow のいずれか(それ以外は warn)', () => {
    expect(normalizeScanDedupe('SKIP')).toBe('skip')
    expect(normalizeScanDedupe(' allow ')).toBe('allow')
    expect(normalizeScanDedupe('overwrite')).toBe('warn')
    expect(normalizeScanDedupe(undefined)).toBe('warn')
  })

  it('confirmBeforeRecord は true のとき true、他は false(棚卸しは既定 false)', () => {
    expect(normalizeScanMode({ name: 'x', actions: [{ column: 'A' }], confirmBeforeRecord: true })?.confirmBeforeRecord).toBe(true)
    expect(normalizeScanMode({ name: 'x', actions: [{ column: 'A' }], confirmBeforeRecord: 'yes' })?.confirmBeforeRecord).toBe(false)
    expect(normalizeScanMode({ name: 'x', actions: [{ column: 'A' }], requireFound: false })?.requireFound).toBe(false)
    expect(normalizeScanMode({ name: 'x', actions: [{ column: 'A' }], enabled: false })?.enabled).toBe(false)
  })

  it('長いカラム名・モード名は上限で切る(シートヘッダーとして扱えない名前を保存しない)', () => {
    const long = 'あ'.repeat(100)
    const mode = normalizeScanMode({ name: long, actions: [{ column: long }] })
    expect(mode?.name.length).toBeLessThanOrEqual(40)
    expect(mode?.actions[0].column.length).toBeLessThanOrEqual(40)
  })
})

describe('normalizeScanModes(リストの正規化)', () => {
  it('配列でない入力は空リスト(保存画面が固まらない)', () => {
    expect(normalizeScanModes(undefined)).toEqual([])
    expect(normalizeScanModes({ modes: [] })).toEqual([])
  })

  it('同一名的な重複は1つだけ残す(UNIQUE name を守る)', () => {
    const out = normalizeScanModes([
      { name: '配布', actions: [{ column: 'A' }] },
      { name: ' 配布 ', actions: [{ column: 'B' }] },
    ])
    expect(out.map((m) => m.name)).toEqual(['配布'])
    expect(out[0].actions[0].column).toBe('A')
  })

  it('id は整数だけ通す(文字列 id は新規扱い)', () => {
    expect(normalizeScanMode({ id: '7', name: 'x', actions: [{ column: 'A' }] })?.id).toBeNull()
    expect(normalizeScanMode({ id: 7, name: 'x', actions: [{ column: 'A' }] })?.id).toBe(7)
  })
})

describe('scanModeFromDb(DB の snake_case 行)', () => {
  it('column_at / payload_key を camelCase に直して読む(片側だけで落ちると設定が壊れる)', () => {
    const mode = scanModeFromDb({
      id: 4,
      name: '棚卸し',
      actions: [{ column: '棚卸済', column_at: '棚卸日時', literal: '済', payload_key: '棚卸済', payload_at_key: '棚卸日時' }],
      dedupe: 'skip',
      confirm_before_record: false,
      require_found: true,
      enabled: true,
      updated_at: '2026-11-16T00:00:00.000Z',
      updated_by: 'a@x',
    })
    expect(mode?.id).toBe(4)
    expect(mode?.dedupe).toBe('skip')
    expect(mode?.actions[0]).toEqual({ column: '棚卸済', columnAt: '棚卸日時', literal: '済', payloadKey: '棚卸済', payloadAtKey: '棚卸日時' })
    expect(mode?.updatedAt).toBe('2026-11-16T00:00:00.000Z')
  })

  it('null・空の actions は null(壊れた行を画面に出さない)', () => {
    expect(scanModeFromDb(null)).toBeNull()
    expect(scanModeFromDb({ id: 1, name: 'x', actions: [] })).toBeNull()
  })
})

describe('scanModeToDb(DB の snake_case)', () => {
  it('id を写す(更新)。column_at / payload_key は snake_case', () => {
    const db = scanModeToDb(baseMode)
    expect(db.id).toBe(1)
    expect(db.confirm_before_record).toBe(true)
    expect(db.require_found).toBe(true)
    expect((db.actions as Array<Record<string, unknown>>)[0]).toEqual({
      column: '来場済',
      column_at: '来場日時',
      literal: '済',
      payload_key: '来場済',
      payload_at_key: '来場日時',
    })
  })

  it('id 無しは写さない(新規 insert で serial id が付く)', () => {
    expect(scanModeToDb({ ...baseMode, id: null }).id).toBeUndefined()
  })
})

describe('recordState(済/未 の表示正規化)', () => {
  it("フラグの 済 / true / 任意文字列は済、空と 未 は未", () => {
    expect(recordState({ 来場済: '済' }, '来場済', '来場日時')).toBe('済')
    expect(recordState({ 来場済: 'true' }, '来場済', '来場日時')).toBe('済')
    expect(recordState({ 来場済: '確認しました' }, '来場済', '来場日時')).toBe('済')
    expect(recordState({ 来場済: '未' }, '来場済', '来場日時')).toBe('未')
    expect(recordState({ 来場済: '' }, '来場済', '来場日時')).toBe('未')
    expect(recordState({}, '来場済', '来場日時')).toBe('未')
  })

  it('no/false/ng 系は「未」側(人が手で書いた未表記を済にしない)', () => {
    expect(recordState({ 来場済: 'no' }, '来場済')).toBe('未')
    expect(recordState({ 来場済: 'false' }, '来場済')).toBe('未')
    expect(recordState({ 来場済: 'NG' }, '来場済')).toBe('未')
  })

  it('フラグが空でも日時があれば済(日時列のみのモードを救済)', () => {
    expect(recordState({ 来場日時: '2026-11-16 09:02 (JST)' }, '来場済', '来場日時')).toBe('済')
    expect(recordState({ 来場日時: '' }, '来場済', '来場日時')).toBe('未')
  })

  it('payload が null/undefined でも落ちない', () => {
    expect(recordState(null, '来場済')).toBe('未')
    expect(recordState(undefined, '来場済')).toBe('未')
  })
})

describe('scanModeSummary(モードの「何を記録するか」)', () => {
  it('フラグ列と日時列を並べ、確認/連続を添える', () => {
    expect(scanModeSummary(baseMode)).toBe('来場済 / 来場日時(確認してから記録)')
    expect(scanModeSummary({ ...baseMode, confirmBeforeRecord: false })).toBe('来場済 / 来場日時(連続で記録)')
    expect(scanModeSummary({ ...baseMode, actions: [{ column: '棚卸済', columnAt: '', literal: '済', payloadKey: '棚卸済', payloadAtKey: '' }] })).toBe('棚卸済(確認してから記録)')
  })
})

describe('formatJst(シートに書く日時・履歴の表示)', () => {
  it('UTC を JST に直して固定文字列にする(toLocaleString 環境差を出さない)', () => {
    expect(formatJst('2026-11-16T00:02:00.000Z')).toBe('2026-11-16 09:02 (JST)')
    expect(formatJst('2026-11-15T15:00:00.000Z')).toBe('2026-11-16 00:00 (JST)')
  })

  it('日跨ぎ・月跨ぎを日付側へ反映する', () => {
    expect(formatJst('2026-12-31T15:30:00.000Z')).toBe('2027-01-01 00:30 (JST)')
  })

  it('空・不正値は空文字(画面にNaNを出さない)', () => {
    expect(formatJst('')).toBe('')
    expect(formatJst(null)).toBe('')
    expect(formatJst('not-a-date')).toBe('')
  })
})

describe('isSameScan(連続スキャンの重複除外)', () => {
  it('同じコードを窓内では無視し、窓外では通す', () => {
    expect(isSameScan('A', 'A', 1000, 2000)).toBe(true)
    expect(isSameScan('A', 'A', 1000, 1000 + 2500)).toBe(false)
  })
  it('別コードは通す(次々と読む連続モード)', () => {
    expect(isSameScan('B', 'A', 1000, 1005)).toBe(false)
  })
  it('空 code は無視しない(空の検出を積み上げない側で扱う)', () => {
    expect(isSameScan('', '', 1000, 1005)).toBe(false)
  })
})

describe('記録履歴の分页と limit', () => {
  const rows: ScanHistoryRow[] = [
    { seq: 30, code: 'A', modeName: 'チェックイン', name: '山田', actorEmail: 'a@x', status: 'ok', written: {}, sheetRange: null, at: '' },
    { seq: 29, code: 'B', modeName: 'チェックイン', name: '鈴木', actorEmail: 'a@x', status: 'duplicate', written: {}, sheetRange: null, at: '' },
  ]

  it('limit と同じ件数なら次カーソル(末尾の seq)を出す', () => {
    expect(historyNextCursor(rows, 2)).toBe('29')
  })
  it('末尾が limit 未満なら null(最終ページ)', () => {
    expect(historyNextCursor(rows, 25)).toBe(null)
  })
  it('空リストは null', () => {
    expect(historyNextCursor([], 25)).toBe(null)
  })

  it('limit は 1..100 に補正(不正値は既定 25)', () => {
    expect(clampHistoryLimit('200')).toBe(100)
    expect(clampHistoryLimit('0')).toBe(1)
    expect(clampHistoryLimit('abc')).toBe(25)
    expect(clampHistoryLimit(undefined)).toBe(25)
  })
})

describe('scanStatusMessage(固定文言)', () => {
  it('すべての状態に文言があり、未知語は出さない', () => {
    expect(scanStatusMessage('ok')).toBe('記録しました')
    expect(scanStatusMessage('duplicate')).toBe('重複(既に記録済み)')
    expect(scanStatusMessage('not_found')).toContain('見つかりません')
    expect(scanStatusMessage('sheet_missing')).toContain('シート行')
    expect(scanStatusMessage('write_failed')).toContain('書き込み失敗')
    expect(scanStatusMessage('skipped')).toContain('記録しない')
  })
})

describe('モードの列とシート・取り込みカラムのつきあいの判定(設定画面の注記)', () => {
  const mode: ScanMode = {
    ...baseMode,
    actions: [
      { column: '来場済', columnAt: '来場日時', literal: '済', payloadKey: '来場済', payloadAtKey: '来場日時' },
      { column: '受け取り済', columnAt: '', literal: '済', payloadKey: '受け取り済', payloadAtKey: '' },
    ],
  }

  it('modeColumns は フラグ+日時を重複なく並べる(空の日時は出さない)', () => {
    expect(modeColumns(mode)).toEqual(['来場済', '来場日時', '受け取り済'])
  })

  it('modeColumnsMissing は シートに無い列だけ出す(headers が不明なら注記しない)', () => {
    expect(modeColumnsMissing(mode, ['ID', '氏名', '来場済', '来場日時'])).toEqual(['受け取り済'])
    expect(modeColumnsMissing(mode, [])).toEqual(['来場済', '来場日時', '受け取り済'])
    expect(modeColumnsMissing(mode, null)).toEqual([])
  })

  it('modeColumnsOutsideInclude は 取り込みカラムに無い列だけ出す(include_columns 空 = 全カラムなので注記しない)', () => {
    expect(modeColumnsOutsideInclude(mode, ['氏名', '来場済', '来場日時'])).toEqual(['受け取り済'])
    expect(modeColumnsOutsideInclude(mode, [])).toEqual([])
  })
})

describe('既定プリセット(migrations/0006 のシードと一致)', () => {
  it('配布は連続・チェックインは確認(dedupe は warn)', () => {
    const distribute = DEFAULT_SCAN_MODES.find((m) => m.name === 'チケット配布')
    const checkin = DEFAULT_SCAN_MODES.find((m) => m.name === 'チェックイン')
    expect(distribute?.confirmBeforeRecord).toBe(false)
    expect(checkin?.confirmBeforeRecord).toBe(true)
    expect(distribute?.dedupe).toBe('warn')
    expect(distribute?.actions[0].column).toBe('配布済')
    expect(distribute?.actions[0].columnAt).toBe('配布日時')
    expect(checkin?.actions[0].column).toBe('来場済')
    expect(checkin?.actions[0].payloadAtKey).toBe('来場日時')
  })
})

describe('flush の上限と自動確定の件数', () => {
  it('上限値は画面・API が同じ定数を読む', () => {
    expect(SCAN_CODES_MAX).toBe(100)
    expect(SCAN_AUTO_FLUSH_COUNT).toBe(5)
  })
})
