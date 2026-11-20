// 跨模块共享的插件状态定义与读写入口：
// Claude Code 校验器要求 read/update 直接引用同文件内的 const atom，
// 因此所有 atom 集中定义在此，并导出类型安全的 get/set 函数，彻底消除跨文件 shape 重复声明。
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type {
  AccountMap,
  Activity,
  InsightView,
  RateSnapshot,
  RateWindow,
  ScanState,
  SessionAgg,
  SessionDetail,
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
export const NO_ACCOUNTS: AccountMap = { bySession: {}, labels: {} }
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

// 会话汇总：agg4 起按模型区分缓存读取倍率（Opus/Sonnet 5.5 为 0.05×）
const sessionsAtom = atom({ plugin: 'cc-context-insights', key: 'sessions' } as const, [] as SessionAgg[], {
  shape: 'sessions-4',
})
const scanAtom = atom({ plugin: 'cc-context-insights', key: 'scan' } as const, IDLE_SCAN, { shape: 'scan-1' })
const DEFAULT_VIEW: InsightView = { range: '7d', sort: 'recent' }
const viewAtom = atom({ plugin: 'cc-context-insights', key: 'view' } as const, DEFAULT_VIEW, { shape: 'view-2' })
const accountsAtom = atom({ plugin: 'cc-context-insights', key: 'accounts' } as const, NO_ACCOUNTS, {
  shape: 'accounts-1',
})
const limitsAtom = atom({ plugin: 'cc-context-insights', key: 'limits' } as const, {} as Record<string, RateSnapshot>, {
  shape: 'limits-1',
})
const liveLimitsAtom = atom({ plugin: 'cc-context-insights', key: 'live-limits' } as const, null as RateSnapshot | null, {
  shape: 'live-limits-1',
})
// 面板默认是洞察总览；在会话列表里双击某个会话，就切到那个会话的上下文（focus = 会话 id）
const focusAtom = atom({ plugin: 'cc-context-insights', key: 'focus' } as const, null as string | null, {
  shape: 'focus-1',
})
const detailAtom = atom({ plugin: 'cc-context-insights', key: 'detail' } as const, null as SessionDetail | null, {
  shape: 'detail-2',
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

export function getDetail($: EngineInterface) {
  return read($, detailAtom)
}
export function setDetail($: EngineInterface, fn: (v: SessionDetail | null) => SessionDetail | null) {
  return update($, detailAtom, fn)
}

// ---------- 实时订阅额度短期缓存（存在本会话状态中，避免总览每次渲染重复调 $.session.usage()） ----------

const LIVE_LIMITS_TTL = 15_000

export async function noteLiveLimits($: EngineInterface, windows: RateWindow[], at: number): Promise<void> {
  await update($, liveLimitsAtom, () => ({ at, windows })).catch(() => undefined)
}

export async function readLiveLimits($: EngineInterface, now: number): Promise<RateWindow[]> {
  const hit = await read($, liveLimitsAtom)
  if (hit && Math.abs(now - hit.at) < LIVE_LIMITS_TTL) return hit.windows
  const live = await $.session.usage().catch(() => undefined)
  const windows: RateWindow[] = (live?.rateLimits ?? []).map(r => ({
    kind: r.kind,
    percentUsed: r.percentUsed,
    resetsAt: r.resetsAt,
  }))
  await update($, liveLimitsAtom, () => ({ at: now, windows })).catch(() => undefined)
  return windows
}
