// 跨模块共享的插件状态定义与读写入口：
// Claude Code 校验器要求 read/update 直接引用同文件内的 const atom，
// 因此所有 atom 集中定义在此，并导出类型安全的 get/set 函数，彻底消除跨文件 shape 重复声明。
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type {
  AccountMap,
  Activity,
  InsightSettings,
  InsightView,
  RateSnapshot,
  RateWindow,
  ScanState,
  SessionAgg,
  Snapshot,
  StepRecord,
  StepTotals,
} from '../types'

export const PLUGIN = 'cc-context-insights'
export const PANE = 'cc-context-insights'
export const TITLE = '上下文洞察'
export const COMMAND = 'ctx-insights'
export const MAX_STEPS = 300
/** 额度快照跨会话保存（$.state 只活在本会话），切换账号后另一个账号的最后读数仍可显示 */
export const LIMITS_STORE_KEY = 'limits-1'
export const NO_ACCOUNTS: AccountMap = { bySession: {}, desktopBySession: {}, labels: {} }
export const IDLE_SCAN: ScanState = { isRunning: false, doneFiles: 0, totalFiles: 0, doneBytes: 0, totalBytes: 0 }

// 字段变了就改 shape：旧版本存下的值会被丢弃，而不是读成错的形状
const stepsAtom = atom({ plugin: 'cc-context-insights', key: 'steps' } as const, [] as StepRecord[], {
  shape: 'steps-1',
})
/** 整个会话的请求累计：steps 只留最近 MAX_STEPS 条画趋势，统计数字不能跟着截断 */
const NO_TOTALS: StepTotals = { count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const stepTotalsAtom = atom({ plugin: 'cc-context-insights', key: 'step-totals' } as const, NO_TOTALS, {
  shape: 'step-totals-1',
})
const turnsAtom = atom({ plugin: 'cc-context-insights', key: 'turns' } as const, 0, { shape: 'turns-1' })
const EMPTY_ACTIVITY: Activity = {
  tools: {},
  errors: 0,
  reads: 0,
  writes: 0,
  searches: 0,
  files: {},
  programs: {},
}
const activityAtom = atom({ plugin: 'cc-context-insights', key: 'activity' } as const, EMPTY_ACTIVITY, {
  shape: 'activity-1',
})
const snapshotAtom = atom({ plugin: 'cc-context-insights', key: 'snapshot' } as const, null as Snapshot | null, {
  shape: 'snapshot-1',
})
const busyAtom = atom({ plugin: 'cc-context-insights', key: 'busy' } as const, false, { shape: 'busy-1' })

// 会话汇总：agg5 起记录各模型计费权重（按成本排模型）与工具上下文估算 token
const sessionsAtom = atom({ plugin: 'cc-context-insights', key: 'sessions' } as const, [] as SessionAgg[], {
  shape: 'sessions-5',
})
const scanAtom = atom({ plugin: 'cc-context-insights', key: 'scan' } as const, IDLE_SCAN, { shape: 'scan-1' })
const DEFAULT_VIEW: InsightView = { range: '7d', sort: 'recent' }
/** 设置跨会话保存在 $.store；本会话状态里放一份，修改后面板立即重绘 */
export const SETTINGS_STORE_KEY = 'settings-1'
const settingsAtom = atom({ plugin: 'cc-context-insights', key: 'settings' } as const, {} as InsightSettings, {
  shape: 'settings-1',
})
const viewAtom = atom({ plugin: 'cc-context-insights', key: 'view' } as const, DEFAULT_VIEW, { shape: 'view-2' })
const accountsAtom = atom({ plugin: 'cc-context-insights', key: 'accounts' } as const, NO_ACCOUNTS, {
  shape: 'accounts-3',
})
const limitsAtom = atom({ plugin: 'cc-context-insights', key: 'limits' } as const, {} as Record<string, RateSnapshot>, {
  shape: 'limits-1',
})
const liveLimitsAtom = atom({ plugin: 'cc-context-insights', key: 'live-limits' } as const, null as RateSnapshot | null, {
  shape: 'live-limits-1',
})
// 面板默认是洞察总览；`/ctx-insights full` 切到当前会话的上下文（focus = 会话 id）
const focusAtom = atom({ plugin: 'cc-context-insights', key: 'focus' } as const, null as string | null, {
  shape: 'focus-1',
})

export function getSteps($: EngineInterface) {
  return read($, stepsAtom)
}
export function setSteps($: EngineInterface, fn: (v: StepRecord[]) => StepRecord[]) {
  return update($, stepsAtom, fn)
}

export function getStepTotals($: EngineInterface) {
  return read($, stepTotalsAtom)
}
export function setStepTotals($: EngineInterface, fn: (v: StepTotals) => StepTotals) {
  return update($, stepTotalsAtom, fn)
}

export function getTurns($: EngineInterface) {
  return read($, turnsAtom)
}
export function setTurns($: EngineInterface, fn: (v: number) => number) {
  return update($, turnsAtom, fn)
}

export function getActivity($: EngineInterface) {
  return read($, activityAtom)
}
export function setActivity($: EngineInterface, fn: (v: Activity) => Activity) {
  return update($, activityAtom, fn)
}

export function getSnapshot($: EngineInterface) {
  return read($, snapshotAtom)
}
export function setSnapshot($: EngineInterface, fn: (v: Snapshot | null) => Snapshot | null) {
  return update($, snapshotAtom, fn)
}

export function getBusy($: EngineInterface) {
  return read($, busyAtom)
}
export function setBusy($: EngineInterface, fn: (v: boolean) => boolean) {
  return update($, busyAtom, fn)
}

export function getSessions($: EngineInterface) {
  return read($, sessionsAtom)
}
export function setSessions($: EngineInterface, fn: (v: SessionAgg[]) => SessionAgg[]) {
  return update($, sessionsAtom, fn)
}

export function getScan($: EngineInterface) {
  return read($, scanAtom)
}
export function setScanState($: EngineInterface, fn: (v: ScanState) => ScanState) {
  return update($, scanAtom, fn)
}

export function getView($: EngineInterface) {
  return read($, viewAtom)
}
export function setViewState($: EngineInterface, fn: (v: InsightView) => InsightView) {
  return update($, viewAtom, fn)
}

export function getSettings($: EngineInterface) {
  return read($, settingsAtom)
}
/** 改设置：写本会话状态（触发重绘）并持久化到 $.store */
export async function setSettings($: EngineInterface, fn: (v: InsightSettings) => InsightSettings) {
  let next: InsightSettings = {}
  await update($, settingsAtom, v => (next = fn(v)))
  await $.store.set(SETTINGS_STORE_KEY, next)
}
/** 会话开始时从 $.store 载入设置 */
export async function loadSettings($: EngineInterface) {
  const stored = (await $.store.get(SETTINGS_STORE_KEY)) as InsightSettings | undefined
  if (stored && typeof stored === 'object') await update($, settingsAtom, () => stored)
}

export function getAccounts($: EngineInterface) {
  return read($, accountsAtom)
}
export function setAccounts($: EngineInterface, fn: (v: AccountMap) => AccountMap) {
  return update($, accountsAtom, fn)
}

export function getLimits($: EngineInterface) {
  return read($, limitsAtom)
}
export function setLimits($: EngineInterface, fn: (v: Record<string, RateSnapshot>) => Record<string, RateSnapshot>) {
  return update($, limitsAtom, fn)
}

export function getFocus($: EngineInterface) {
  return read($, focusAtom)
}
export function setFocus($: EngineInterface, fn: (v: string | null) => string | null) {
  return update($, focusAtom, fn)
}

// ---------- 实时订阅额度短期缓存（存在本会话状态中，避免总览每次渲染重复调 $.session.usage()） ----------

const LIVE_LIMITS_TTL = 15_000

export async function noteLiveLimits($: EngineInterface, windows: RateWindow[], at: number): Promise<void> {
  await update($, liveLimitsAtom, () => ({ at, windows })).catch(() => undefined)
}

/** 模块内缓存：绘制时不允许写状态（写入会被拒绝），所以绘制里取到的读数存在这里，避免每次滚动都调一次 usage() */
let liveMemo: { at: number; windows: RateWindow[] } | undefined

export async function readLiveLimits($: EngineInterface, now: number): Promise<RateWindow[]> {
  if (liveMemo && Math.abs(now - liveMemo.at) < LIVE_LIMITS_TTL) return liveMemo.windows
  const hit = await read($, liveLimitsAtom)
  if (hit && Math.abs(now - hit.at) < LIVE_LIMITS_TTL) {
    liveMemo = hit
    return hit.windows
  }
  const live = await $.session.usage().catch(() => undefined)
  const windows: RateWindow[] = (live?.rateLimits ?? []).map(r => ({
    kind: r.kind,
    percentUsed: r.percentUsed,
    resetsAt: r.resetsAt,
  }))
  liveMemo = { at: now, windows }
  await update($, liveLimitsAtom, () => ({ at: now, windows })).catch(() => undefined)
  return windows
}
