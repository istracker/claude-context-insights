// 跨会话洞察：汇总 ~/.claude/projects 下所有会话的用量、成本与活动
import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderInput } from 'claude-code'

import type {
  AccountMap,
  DayAgg,
  InsightRange,
  InsightSort,
  InsightView,
  RateSnapshot,
  RateWindow,
  ScanState,
  SessionDetail,
  SessionAgg,
} from '../types'
import { dayKey, loadSessionDetail, runScan } from './scan'
import {
  ACCENT,
  AMBER,
  BLUE,
  ORANGE,
  PALETTE,
  TEAL,
  contextTrendSvg,
  dailyAverage,
  dailySvg,
  hoursSvg,
  rankSvg,
  stackSvg,
  svgSize,
} from './charts'
import type { DayPoint } from './charts'
import {
  bump,
  fmtAgo,
  fmtTokens,
  fmtUntil,
  fmtUsd,
  paneWidths,
  pct,
  sparkline,
  textBar,
  topEntries,
  windowLabel,
} from './util'

// 状态引用与 scan.ts 共用（同一 plugin+key 指向同一份状态）
const sessionsAtom = atom({ plugin: 'cc-context-insights', key: 'sessions' } as const, [] as SessionAgg[], {
  shape: 'sessions-3',
})
const IDLE: ScanState = { isRunning: false, doneFiles: 0, totalFiles: 0, doneBytes: 0, totalBytes: 0 }
const scanAtom = atom({ plugin: 'cc-context-insights', key: 'scan' } as const, IDLE, { shape: 'scan-1' })
// 会话默认按时间排；改了默认值就换 shape，让旧会话里存的「按成本」失效
const DEFAULT_VIEW: InsightView = { range: '7d', sort: 'recent' }
const viewAtom = atom({ plugin: 'cc-context-insights', key: 'view' } as const, DEFAULT_VIEW, { shape: 'view-2' })
const NO_ACCOUNTS: AccountMap = { bySession: {}, labels: {} }
const accountsAtom = atom({ plugin: 'cc-context-insights', key: 'accounts' } as const, NO_ACCOUNTS, { shape: 'accounts-1' })
const limitsAtom = atom({ plugin: 'cc-context-insights', key: 'limits' } as const, {} as Record<string, RateSnapshot>, {
  shape: 'limits-1',
})
/** 与 register.tsx 的 LIMITS_STORE_KEY 相同 */
const LIMITS_STORE_KEY = 'limits-1'

// 洞察已并入「上下文」面板，作为其中一个标签页
const PANE = 'cc-context-insights'
const TITLE = '上下文洞察'
// 与 register.tsx / scan.ts 共用
const focusAtom = atom({ plugin: 'cc-context-insights', key: 'focus' } as const, null as string | null, {
  shape: 'focus-1',
})
const detailAtom = atom({ plugin: 'cc-context-insights', key: 'detail' } as const, null as SessionDetail | null, {
  shape: 'detail-1',
})

// ---------- 双击会话 ----------
// 按钮事件不带点击次数，自己判断：同一会话在 DOUBLE_MS 内按两次算双击
const DOUBLE_MS = 450
let lastPress: { id: string; at: number } | undefined
/** 已为哪个会话发起过加载，避免渲染时重复发起 */
let requestedDetail: string | undefined

async function pressSession($: EngineInterface, id: string, file: string | undefined): Promise<void> {
  const now = await $.clock.now()
  const isDouble = lastPress !== undefined && lastPress.id === id && now - lastPress.at <= DOUBLE_MS
  lastPress = isDouble ? undefined : { id, at: now }
  if (!isDouble) return
  await update($, focusAtom, () => id)
  const current = await $.session.id().catch(() => undefined)
  if (id !== current && file) {
    requestedDetail = id
    void loadSessionDetail($, id, file)
  }
}
/** 「上下文」面板里渲染函数的输入 */
export type PaneInput = RenderInput<'Pane'>
const COMMAND = 'ctx-insights'
const DAY_MS = 86_400_000


// ---------- 成本拆分 ----------

type Part = 'in' | 'cw' | 'cr' | 'out'
const PARTS: { key: Part; name: string; color: string }[] = [
  { key: 'cw', name: '缓存写入', color: BLUE },
  { key: 'out', name: '输出', color: ORANGE },
  { key: 'cr', name: '缓存读取', color: TEAL },
  { key: 'in', name: '输入', color: AMBER },
]

/**
 * 各类 token 相对「输入」单价的倍数（Claude 标价比例，各模型一致）：
 * 5 分钟缓存写 1.25、1 小时缓存写 2、缓存读 0.1、输出 5。
 * 用来把会话总成本（cost-state）摊到每一天、每一类。
 */
export function partWeights(d: DayAgg): Record<Part, number> {
  return {
    in: d.in,
    cw: (d.cw - d.cw1h) * 1.25 + d.cw1h * 2,
    cr: d.cr * 0.1,
    out: d.out * 5,
  }
}

function weight(d: DayAgg): number {
  const w = partWeights(d)
  return w.in + w.cw + w.cr + w.out
}

export function tokensOf(t: { in: number; out: number; cr: number; cw: number }): number {
  return t.in + t.out + t.cr + t.cw
}

// ---------- 合并与汇总 ----------

/** 主会话与它的子 Agent 文件合并为一个会话 */
export type MergedSession = {
  id: string
  title: string
  project: string
  lastAt: number
  /** 会话成本：cost-state 为准，缺的部分按学到的比率估算 */
  costUsd?: number
  /** 成本里含估算部分（进行中或恢复过的会话） */
  isEstimated: boolean
  days: Record<string, DayAgg>
  /** 每一天分到的成本 */
  dayUsd: Record<string, number>
  account?: string
}

function mergeMap(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  let out = a
  for (const [k, v] of Object.entries(b)) out = bump(out, k, v)
  return out
}

function mergeDay(a: DayAgg | undefined, b: DayAgg): DayAgg {
  if (!a) return { ...b }
  return {
    in: a.in + b.in,
    out: a.out + b.out,
    cr: a.cr + b.cr,
    cw: a.cw + b.cw,
    cw1h: a.cw1h + b.cw1h,
    req: a.req + b.req,
    prompts: a.prompts + b.prompts,
    models: mergeMap(a.models, b.models),
    tools: mergeMap(a.tools, b.tools),
    skills: mergeMap(a.skills, b.skills),
    programs: mergeMap(a.programs, b.programs),
    hours: mergeMap(a.hours, b.hours),
  }
}

/**
 * 合并主会话与子 Agent，并给出会话成本。
 * cost-state 要到会话结束（或暂停）才写入，进行中的会话没有它、恢复过的会话它会过期。
 * 这两种情况按「每单位计费权重多少钱」估算：这个比率从有 cost-state 的会话里按模型学出来，
 * 不写死任何模型的价格。
 */
export function mergeSessions(aggs: SessionAgg[]): MergedSession[] {
  const byId = new Map<string, SessionAgg[]>()
  for (const a of aggs) byId.set(a.id, [...(byId.get(a.id) ?? []), a])

  type Group = { id: string; main: SessionAgg; days: Record<string, DayAgg>; lastAt: number; model: string; subW: number }
  const groups: Group[] = []
  for (const [id, parts] of byId) {
    const main = parts.find(p => !p.isSub) ?? parts[0]
    if (!main) continue
    const days: Record<string, DayAgg> = {}
    let lastAt = 0
    let subW = 0
    for (const p of parts) {
      for (const [k, d] of Object.entries(p.days)) days[k] = mergeDay(days[k], d)
      lastAt = Math.max(lastAt, p.lastAt ?? 0)
      if (p !== main) subW += p.weight ?? 0
    }
    let models: Record<string, number> = {}
    for (const d of Object.values(days)) models = mergeMap(models, d.models)
    const model = topEntries(models, 1)[0]?.[0] ?? 'unknown'
    groups.push({ id, main, days, lastAt, model, subW })
  }

  // 学习每个模型的「美元 / 计费权重」
  const learned = new Map<string, { usd: number; w: number }>()
  for (const g of groups) {
    const w = g.main.costAtWeight ?? 0
    if (g.main.costUsd === undefined || w <= 0) continue
    for (const k of [g.model, '*']) {
      const cur = learned.get(k) ?? { usd: 0, w: 0 }
      learned.set(k, { usd: cur.usd + g.main.costUsd, w: cur.w + w })
    }
  }
  const rateOf = (model: string): number | undefined => {
    const r = learned.get(model) ?? learned.get('*')
    return r && r.w > 0 ? r.usd / r.w : undefined
  }

  const out: MergedSession[] = []
  for (const { id, main, days, lastAt, model, subW } of groups) {
    const rate = rateOf(model)
    let cost: number | undefined
    let isEstimated = false
    if (main.costUsd !== undefined) {
      const extra = main.weight - (main.costAtWeight ?? main.weight)
      cost = main.costUsd
      if (extra > 0 && rate !== undefined) {
        cost += extra * rate
        isEstimated = true
      }
    } else if (rate !== undefined) {
      cost = (main.weight + subW) * rate
      isEstimated = cost > 0
    }
    const totalW = Object.values(days).reduce((s, d) => s + weight(d), 0)
    const dayUsd: Record<string, number> = {}
    if (cost !== undefined && totalW > 0) {
      for (const [k, d] of Object.entries(days)) dayUsd[k] = (cost * weight(d)) / totalW
    }
    const cwd = main.cwd
    out.push({
      id,
      title: main.title ?? main.lastPrompt ?? id.slice(0, 8),
      project: cwd ? (cwd.split('/').filter(Boolean).slice(-1)[0] ?? cwd) : '未知项目',
      lastAt,
      costUsd: cost,
      isEstimated,
      days,
      dayUsd,
    })
  }
  return out
}

/** 上一个等长时间段，用于环比；「全部」没有 */
export function prevRangeDays(range: InsightRange, now: number, tzMin: number): Set<string> | undefined {
  if (range === 'all') return undefined
  const n = range === 'today' ? 1 : range === '7d' ? 7 : 30
  const out = new Set<string>()
  for (let i = n; i < 2 * n; i++) out.add(dayKey(now - i * DAY_MS, tzMin))
  return out
}

export function rangeDays(range: InsightRange, now: number, tzMin: number): Set<string> | undefined {
  if (range === 'all') return undefined
  const n = range === 'today' ? 1 : range === '7d' ? 7 : 30
  const out = new Set<string>()
  for (let i = 0; i < n; i++) out.add(dayKey(now - i * DAY_MS, tzMin))
  return out
}

/** 一段时间内的汇总 */
export type Totals = {
  in: number
  out: number
  cr: number
  cw: number
  req: number
  prompts: number
  usd: number
  usdBy: Record<Part, number>
  models: Record<string, number>
  tools: Record<string, number>
  skills: Record<string, number>
  programs: Record<string, number>
  hours: Record<string, number>
}

export function emptyTotals(): Totals {
  return {
    in: 0,
    out: 0,
    cr: 0,
    cw: 0,
    req: 0,
    prompts: 0,
    usd: 0,
    usdBy: { in: 0, cw: 0, cr: 0, out: 0 },
    models: {},
    tools: {},
    skills: {},
    programs: {},
    hours: {},
  }
}

/** 把会话在某些天里的数据加进 t；days 为 undefined 表示全部 */
export function addSession(t: Totals, s: MergedSession, days: Set<string> | undefined): Totals {
  const own = emptyTotals()
  for (const [k, d] of Object.entries(s.days)) {
    if (days && !days.has(k)) continue
    const usd = s.dayUsd[k] ?? 0
    const w = partWeights(d)
    const sum = w.in + w.cw + w.cr + w.out
    for (const p of PARTS) {
      const share = sum > 0 ? (usd * w[p.key]) / sum : 0
      own.usdBy[p.key] += share
      t.usdBy[p.key] += share
    }
    for (const target of [own, t]) {
      target.in += d.in
      target.out += d.out
      target.cr += d.cr
      target.cw += d.cw
      target.req += d.req
      target.prompts += d.prompts
      target.usd += usd
    }
    t.models = mergeMap(t.models, d.models)
    t.tools = mergeMap(t.tools, d.tools)
    t.skills = mergeMap(t.skills, d.skills)
    t.programs = mergeMap(t.programs, d.programs)
    t.hours = mergeMap(t.hours, d.hours)
  }
  return own
}

/** MCP 工具按服务合并：mcp__Claude_Browser__computer → Claude_Browser（MCP） */
/** MCP 服务名：连接器用 UUID 命名，显示成「连接器 1a59」 */
export function serverLabel(server: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(server) ? `连接器 ${server.slice(0, 4)}` : server
}

export function groupTools(tools: Record<string, number>): Record<string, number> {
  let out: Record<string, number> = {}
  for (const [name, n] of Object.entries(tools)) {
    const m = /^mcp__(.+?)__/.exec(name)
    out = bump(out, m ? `${serverLabel(m[1] ?? '')}（MCP）` : name, n)
  }
  return out
}

export function shortTool(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${serverLabel(m[1] ?? '')} · ${m[2]}` : name
}

/** 账号显示名：邮箱，没见过就用 id 前 4 位 */
export function accountLabel(acc: AccountMap, id: string | undefined): string {
  if (id === undefined) return '未归属'
  const l = acc.labels[id]
  const base = l?.email ?? l?.name ?? `账号 ${id.slice(0, 4)}`
  return id === acc.current ? `${base}（当前）` : base
}

// ---------- 文案 ----------

const RANGES: [InsightRange, string][] = [
  ['today', '今天'],
  ['7d', '7 天'],
  ['30d', '30 天'],
  ['all', '全部'],
]
const RANGE_TITLE: Record<InsightRange, string> = { today: '今天', '7d': '近 7 天', '30d': '近 30 天', all: '全部时间' }
const PREV_TITLE: Record<InsightRange, string> = { today: '昨天', '7d': '前 7 天', '30d': '前 30 天', all: '' }
const SORTS: [InsightSort, string][] = [
  ['recent', '按时间'],
  ['cost', '按成本'],
]
/** 每类成本是什么，只给占比最高的一类显示 */
const PART_HINT: Record<Part, string> = {
  cw: '上下文变化后要重新写入缓存，单价是输入的 1.25～2 倍',
  out: '模型生成的回复与工具调用参数，单价最高',
  cr: '复用已缓存的上下文，单价只有输入的十分之一',
  in: '没有命中缓存的输入',
}
const ACCOUNT_COLORS = PALETTE
/** 排行模块：可见行数、最多行数、行高（与 rankSvg 一致） */
const RANK_VISIBLE = 6
const RANK_MAX = 20
const RANK_ROW = 26
/** 排行的标题旁注：超过可见行数时提示可滑动 */
const rankNote = (n: number, base?: string): string | undefined =>
  n > RANK_VISIBLE ? `${base ? base + ' · ' : ''}共 ${Math.min(n, RANK_MAX)} 项，可上下滑动` : base

// ---------- 注册 ----------

/** 会话开始时调用：注册命令并做一次增量扫描（只读上次之后新增的日志） */
export async function startInsights($: EngineInterface): Promise<void> {
  await $.command.register({
    name: COMMAND,
    description: '打开上下文洞察：本会话的上下文窗口，以及所有会话的额度、成本与活动（加 full 精确统计）',
  })
  // 各账号上次的额度读数存在 $.store（跨会话），载入到本会话状态
  const stored = (await $.store.get(LIMITS_STORE_KEY)) as Record<string, RateSnapshot> | undefined
  if (stored && typeof stored === 'object') await update($, limitsAtom, () => stored)
  void runScan($)
}

// /ctx-insights 的处理在 register.tsx（要调用本会话的精确统计）

/** 「洞察」标签页的内容：所有会话的额度、成本、会话与活动 */
export async function renderInsights($: EngineInterface, e: PaneInput): Promise<JSX.Element> {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Select } = els
    // 终端的元素表里也有 Svg，但画不出来：按绘制端判断，终端用文字兜底
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    // 显式给高度（不给时桌面端内嵌框默认 150px）；宽度留空，由宿主按「自身宽度、不超过面板」决定。
    // 高度多留 4%，防宽度略估大时被等比缩放后裁底；viewHeight 小于内容高度时，模块内部可上下滑动
    const Chart = (p: { source: string; alt: string; isInteractive?: boolean; viewHeight?: number }) => {
      if (!Svg) return null
      // 注意：JSX 编译成全局 h(...)，局部变量不能叫 h
      const contentHeight = svgSize(p.source).height
      return (
        <Svg source={p.source} alt={p.alt} height={p.viewHeight ?? Math.ceil(contentHeight * 1.04) + 2} isInteractive />
      )
    }
    const aggs = await read($, sessionsAtom)
    const scan = await read($, scanAtom)
    const view = await read($, viewAtom)
    const accounts = await read($, accountsAtom)
    const now = await $.clock.now()
    const tzMin = scan.tzMin ?? -new Date().getTimezoneOffset()
    const setView = (fn: (v: InsightView) => InsightView) => void update($, viewAtom, fn)
    const { full, half } = paneWidths(e.props.bodyColumns)

    // ----- 数据 -----
    const all = mergeSessions(aggs).map(s => ({ ...s, account: accounts.bySession[s.id] }))
    const scoped =
      view.account === undefined
        ? all
        : all.filter(s => (view.account === 'none' ? s.account === undefined : s.account === view.account))
    const accountIds = [...new Set(all.map(s => s.account).filter((a): a is string => a !== undefined))].sort((a, b) =>
      a === accounts.current ? -1 : b === accounts.current ? 1 : a.localeCompare(b),
    )
    const hasUnassigned = all.some(s => s.account === undefined && Object.keys(s.days).length > 0)

    const days = rangeDays(view.range, now, tzMin)
    const total = emptyTotals()
    let projects: Record<string, number> = {}
    let unpriced = 0
    const active: (MergedSession & { r: Totals })[] = []
    for (const s of scoped) {
      const r = addSession(total, s, days)
      if (r.req === 0 && r.prompts === 0) continue
      active.push({ ...s, r })
      projects = bump(projects, s.project, r.usd)
      if (s.costUsd === undefined) unpriced += 1
    }
    const prompted = total.in + total.cr + total.cw

    const prevDays = prevRangeDays(view.range, now, tzMin)
    let prevUsd: number | undefined
    let prevTokens: number | undefined
    if (prevDays) {
      const prev = emptyTotals()
      for (const s of scoped) addSession(prev, s, prevDays)
      prevUsd = prev.usd
      prevTokens = tokensOf(prev)
    }
    const delta = prevUsd !== undefined && prevUsd > 0.5 ? (total.usd - prevUsd) / prevUsd : undefined
    const tokenDelta =
      prevTokens !== undefined && prevTokens > 100_000 ? (tokensOf(total) - prevTokens) / prevTokens : undefined

    const byAccount = new Map<string, number>()
    for (const s of all) {
      const r = addSession(emptyTotals(), s, days)
      if (r.usd <= 0) continue
      const k = s.account ?? 'none'
      byAccount.set(k, (byAccount.get(k) ?? 0) + r.usd)
    }
    const accountTotal = [...byAccount.values()].reduce((a, b) => a + b, 0)

    // 订阅额度：当前账号取实时读数，其他账号取切换前存下的最后读数
    const storedLimits = await read($, limitsAtom)
    const live = await $.session.usage().catch(() => undefined)
    const liveWindows: RateWindow[] = (live?.rateLimits ?? []).map(r => ({
      kind: r.kind,
      percentUsed: r.percentUsed,
      resetsAt: r.resetsAt,
    }))
    const currentId = accounts.current ?? 'current'
    type LimitRow = RateSnapshot & { account: string; isLive: boolean }
    const limitRows: LimitRow[] = []
    if (liveWindows.length > 0) limitRows.push({ account: currentId, at: now, windows: liveWindows, isLive: true })
    else if (storedLimits[currentId]) limitRows.push({ ...storedLimits[currentId], account: currentId, isLive: false })
    for (const [k, v] of Object.entries(storedLimits)) {
      if (k !== currentId && k !== 'current') limitRows.push({ ...v, account: k, isLive: false })
    }
    const shownLimits = view.account && view.account !== 'none' ? limitRows.filter(r => r.account === view.account) : limitRows

    const seriesDays = view.range === '30d' || view.range === 'all' ? 30 : 7
    const series: DayPoint[] = []
    for (let i = seriesDays - 1; i >= 0; i--) {
      const k = dayKey(now - i * DAY_MS, tzMin)
      const p: DayPoint = { day: k, usd: 0, tokens: 0, req: 0, prompts: 0 }
      for (const s of scoped) {
        const d = s.days[k]
        if (!d) continue
        p.tokens += tokensOf(d)
        p.req += d.req
        p.prompts += d.prompts
        p.usd += s.dayUsd[k] ?? 0
      }
      series.push(p)
    }

    const parts = [...PARTS].sort((a, b) => total.usdBy[b.key] - total.usdBy[a.key])
    const topPart = parts[0]
    const hourVals = Array.from({ length: 24 }, (_, i) => total.hours[String(i)] ?? 0)
    const busiest = hourVals.indexOf(Math.max(...hourVals))
    const sorted = [...active].sort((a, b) => (view.sort === 'cost' ? b.r.usd - a.r.usd : b.lastAt - a.lastAt))
    /** 会话 id → 主日志文件（双击后从它还原上下文） */
    const mainFiles = new Map(aggs.filter(a => !a.isSub).map(a => [a.id, a.file] as const))
    const currentSessionId = await $.session.id().catch(() => undefined)
    const shownSessions = view.showAllSessions ? sorted.slice(0, 40) : sorted.slice(0, 6)

    // ----- 小组件 -----
    const Section = (props: { title: string; note?: string; right?: JSX.Element | null; children?: unknown }) => (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
          <Box flexDirection="row" columnGap={1} alignItems="center">
            <Text weight="semibold">{props.title}</Text>
            {props.note ? (
              <Text dimColor size="footnote">
                {props.note}
              </Text>
            ) : null}
          </Box>
          {props.right ?? null}
        </Box>
        {props.children as JSX.Element}
      </Box>
    )
    /** 三列图例：■ 名称 · 金额（灰）· 占比，与 Claude 原生上下文用量界面一致 */
    /** 主数字：标签 · 大号数值 · 环比 */
    const heroStat = (label: string, value: string, change: number | undefined) => (
      <Box flexDirection="column">
        <Text dimColor size="footnote">
          {label}
        </Text>
        <Box flexDirection="row" alignItems="flex-end" columnGap={2}>
          <Text weight="bold" size="title" tabular>
            {value}
          </Text>
          {change !== undefined ? (
            <Text
              size="footnote"
              color={change > 0.05 ? ORANGE : change < -0.05 ? TEAL : undefined}
              dimColor={Math.abs(change) <= 0.05}
            >
              {change > 0 ? '↑' : '↓'} {Math.abs(change * 100).toFixed(0)}% 比{PREV_TITLE[view.range]}
            </Text>
          ) : null}
        </Box>
      </Box>
    )
    /** 图例：■ 名称 · [token] · 金额 · 占比 */
    const legendRow = (
      key: string,
      color: string,
      name: string,
      amount: string,
      share: string,
      isDim = false,
      tokens?: string,
    ) => (
      <Box key={key} flexDirection="row" alignItems="center" columnGap={2}>
        <Box flexDirection="row" flexGrow={1} columnGap={1}>
          <Text color={color}>■</Text>
          <Text wrap="truncate-end" dimColor={isDim}>
            {name}
          </Text>
        </Box>
        {tokens !== undefined ? (
          <Box minWidth={11} justifyContent="flex-end">
            <Text tabular dimColor>
              {tokens}
            </Text>
          </Box>
        ) : null}
        <Box minWidth={9} justifyContent="flex-end">
          <Text tabular dimColor>
            {amount}
          </Text>
        </Box>
        <Box minWidth={7} justifyContent="flex-end">
          <Text tabular dimColor={isDim}>
            {share}
          </Text>
        </Box>
      </Box>
    )
    /**
     * 排行模块：固定显示 RANK_VISIBLE 行的高度，图里最多放 RANK_MAX 行，超出部分在模块内上下滑动。
     * 终端没有内部滚动，只列前 RANK_VISIBLE 行。
     */
    const rankBlock = (key: string, rows: [string, number][], fmt: (v: number) => string, width = half) => {
      const max = rows[0]?.[1] ?? 1
      if (rows.length === 0) return <Text dimColor>暂无</Text>
      return Svg ? (
        <Chart
          key={key}
          source={rankSvg(rows.slice(0, RANK_MAX), fmt, width)}
          alt="排行"
          isInteractive
          viewHeight={RANK_ROW * Math.min(rows.length, RANK_VISIBLE) + 6}
        />
      ) : (
        <Box key={key} flexDirection="column">
          {rows.slice(0, RANK_VISIBLE).map(([k, v]) => (
            <Box key={`${key}-${k}`} flexDirection="row" columnGap={1}>
              <Text color={ACCENT}>{textBar((v / max) * 100, 6)}</Text>
              <Text wrap="truncate-end">{k}</Text>
              <Text dimColor tabular>
                {fmt(v)}
              </Text>
            </Box>
          ))}
        </Box>
      )
    }
    /** 一个额度窗口：名称 · 条 · 已用 · 重置时间 */
    const quotaRow = (key: string, w: RateWindow) => {
      const resetAt = w.resetsAt ? Date.parse(w.resetsAt) : NaN
      const isReset = !Number.isNaN(resetAt) && resetAt <= now
      const p = Math.max(0, Math.min(100, w.percentUsed))
      const color = p >= 80 ? ORANGE : ACCENT
      return (
        <Box key={key} flexDirection="row" alignItems="center" columnGap={2}>
          <Box minWidth={10}>
            <Text>{windowLabel(w.kind)}</Text>
          </Box>
          <Box flexGrow={1}>
            {Svg ? (
              <Chart
                source={stackSvg(
                  [
                    { name: '已用', value: isReset ? 0 : p, color, note: `${w.percentUsed}%` },
                    { name: '剩余', value: isReset ? 100 : 100 - p, color: 'track' },
                  ],
                  Math.max(120, full - 300),
                )}
                alt={`${windowLabel(w.kind)}额度已用 ${w.percentUsed}%`}
              />
            ) : (
              <Text color={color}>{textBar(isReset ? 0 : p, 20)}</Text>
            )}
          </Box>
          <Box minWidth={6} justifyContent="flex-end">
            <Text tabular weight="semibold" color={isReset ? undefined : p >= 80 ? ORANGE : undefined} dimColor={isReset}>
              {isReset ? '—' : `${w.percentUsed}%`}
            </Text>
          </Box>
          <Box minWidth={16} justifyContent="flex-end">
            <Text dimColor size="footnote" tabular>
              {Number.isNaN(resetAt) ? '' : isReset ? '已重置' : `${fmtUntil(resetAt - now)}后重置`}
            </Text>
          </Box>
        </Box>
      )
    }
    const count = (v: number) => String(v)
    const top = (map: Record<string, number>, n: number) => topEntries(map, n).filter(([, v]) => v > 0)
    const projRows = top(projects, RANK_MAX)
    const toolRows = top(
      view.expandMcp
        ? Object.fromEntries(Object.entries(total.tools).map(([k, v]) => [shortTool(k), v]))
        : groupTools(total.tools),
      RANK_MAX,
    )
    const progRows = top(total.programs, RANK_MAX)
    const skillRows = top(total.skills, RANK_MAX)
    const modelRows = top(total.models, RANK_MAX)
    const pctDone = scan.totalBytes > 0 ? Math.round((scan.doneBytes / scan.totalBytes) * 100) : 100

    const accountOptions = [
      { value: 'all', label: '全部账号' },
      ...accountIds.map(id => ({ value: id, label: accountLabel(accounts, id) })),
      ...(hasUnassigned ? [{ value: 'none', label: '未归属' }] : []),
    ]

    // ----- 版面 -----
    return (
      <Box flexDirection="column" gap={3} paddingX={1} paddingY={1}>
        {/* 工具栏 */}
        <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" rowGap={1} columnGap={2}>
          <Box flexDirection="row" columnGap={1}>
            {RANGES.map(([r, label]) => (
              <Button
                key={`range-${r}`}
                label={label}
                variant={view.range === r ? 'primary' : 'secondary'}
                onPress={() => setView(v => ({ ...v, range: r }))}
              />
            ))}
          </Box>
          <Box flexDirection="row" columnGap={2} alignItems="center">
            {accountIds.length > 0 ? (
              <Select
                key="account"
                options={accountOptions}
                value={view.account ?? 'all'}
                onSelect={value => setView(v => ({ ...v, account: value === 'all' ? undefined : value }))}
              />
            ) : null}
            <Button
              key="rescan"
              label={scan.isRunning ? `扫描中 ${pctDone}%` : '刷新'}
              plain
              dimColor
              onPress={() => void runScan($)}
            />
          </Box>
        </Box>

        {scan.error ? <Text color="error">扫描出错：{scan.error}</Text> : null}

        {/* 订阅额度：重度用户最关心会不会撞上限 */}
        <Section
          title="订阅额度"
          note={shownLimits.length === 0 ? '发一条消息后显示' : shownLimits[0]?.isLive ? '实时' : undefined}
        >
          {shownLimits.map(r => (
            <Box key={`quota-${r.account}`} flexDirection="column" gap={1}>
              {limitRows.length > 1 || !r.isLive ? (
                <Text dimColor size="footnote">
                  {accountLabel(accounts, r.account === 'current' ? undefined : r.account).replace('未归属', '当前账号')}
                  {r.isLive ? '' : ` · ${fmtAgo(now - r.at)}的读数，切换到该账号后更新`}
                </Text>
              ) : null}
              {r.windows.map(w => quotaRow(`q-${r.account}-${w.kind}`, w))}
            </Box>
          ))}
        </Section>

        {/* 主数字：成本与 token 并列 */}
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={6} rowGap={1}>
            {heroStat(`${RANGE_TITLE[view.range]} · 等价 API 成本`, fmtUsd(total.usd), delta)}
            {heroStat('Token 消耗', fmtTokens(tokensOf(total)), tokenDelta)}
          </Box>
          <Text dimColor>
            {active.length} 个会话 · {total.prompts} 次提问
            {total.prompts > 0
              ? ` · 每次提问 ${fmtUsd(total.usd / total.prompts)} / ${fmtTokens(Math.round(tokensOf(total) / total.prompts))} token`
              : ''}{' '}
            · 缓存命中 {pct(total.cr, prompted)}
          </Text>
          {scan.isRunning ? (
            <Text dimColor size="footnote">
              正在读取会话日志 {scan.doneFiles}/{scan.totalFiles}，数字会随扫描增加
            </Text>
          ) : null}
        </Box>

        {/* 会话 */}
        <Section
          title="会话"
          note={active.length > 0 ? `${active.length} 个 · 双击查看会话的上下文` : undefined}
          right={
            <Box flexDirection="row" columnGap={1}>
              {SORTS.map(([s, label]) => (
                <Button
                  key={`sort-${s}`}
                  label={label}
                  plain
                  dimColor={view.sort !== s}
                  onPress={() => setView(v => ({ ...v, sort: s }))}
                />
              ))}
            </Box>
          }
        >
          {active.length === 0 ? (
            <Text dimColor>{scan.isRunning ? '正在扫描…' : '这段时间没有会话。'}</Text>
          ) : null}
          <Box flexDirection="column" gap={1}>
            {shownSessions.map(s => (
              <Box key={`s-${s.id}`} flexDirection="row" columnGap={3}>
                {/* 左：标题与说明；右：成本在上、token 在下，两列各自右对齐 */}
                <Box flexDirection="column" flexGrow={1}>
                  {/* 标题即入口：双击进入该会话的上下文 */}
                  <Button key={`open-${s.id}`} plain onPress={() => void pressSession($, s.id, mainFiles.get(s.id))}>
                    <Text wrap="truncate-end" weight="medium">
                      {s.title}
                    </Text>
                    {s.id === currentSessionId ? <Text color={ACCENT}> · 当前</Text> : null}
                  </Button>
                  <Box flexDirection="row" columnGap={2} alignItems="center">
                    <Text dimColor size="footnote" wrap="truncate-end">
                      {view.account === undefined && accountIds.length > 1
                        ? `${accountLabel(accounts, s.account).replace('（当前）', '').replace(/@.*/, '')} · `
                        : ''}
                      {s.project} · {fmtAgo(now - s.lastAt)} · {s.r.prompts} 次提问
                    </Text>
                    <Button
                      key={`copy-${s.id}`}
                      label="复制恢复命令"
                      plain
                      dimColor
                      onPress={() => void $.ui.copy({ text: `claude --resume ${s.id}`, surface: e.surface })}
                    />
                  </Box>
                </Box>
                <Box flexDirection="column" alignItems="flex-end" minWidth={12}>
                  <Text tabular weight="semibold">
                    {s.costUsd === undefined ? '—' : `${s.isEstimated ? '≈ ' : ''}${fmtUsd(s.r.usd)}`}
                  </Text>
                  <Text tabular dimColor size="footnote">
                    {fmtTokens(tokensOf(s.r))} token
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
          {sorted.length > 6 ? (
            <Button
              key="more-sessions"
              label={view.showAllSessions ? '收起' : `显示全部 ${sorted.length} 个`}
              plain
              dimColor
              onPress={() => setView(v => ({ ...v, showAllSessions: !v.showAllSessions }))}
            />
          ) : null}
        </Section>

        {/* 钱花在哪 */}
        <Section title="钱花在哪">
          {Svg && total.usd > 0 ? (
            <Chart
              source={stackSvg(parts.map(p => ({ name: p.name, value: total.usdBy[p.key], color: p.color, note: fmtUsd(total.usdBy[p.key]) })), full)}
              alt="成本构成"
              isInteractive
            />
          ) : null}
          <Box flexDirection="column">
            {parts.map(p =>
              legendRow(
                `part-${p.key}`,
                p.color,
                p.name,
                fmtUsd(total.usdBy[p.key]),
                pct(total.usdBy[p.key], total.usd),
                total.usdBy[p.key] === 0,
                `${fmtTokens(total[p.key])} token`,
              ),
            )}
          </Box>
          {topPart && total.usd > 0 ? (
            <Text dimColor size="footnote">
              {topPart.name}占 {pct(total.usdBy[topPart.key], total.usd)}：{PART_HINT[topPart.key]}。
            </Text>
          ) : null}
        </Section>

        {/* 每日 */}
        <Section
          title="每日成本"
          note={`今天 ${fmtUsd(series[series.length - 1]?.usd ?? 0)} / ${fmtTokens(series[series.length - 1]?.tokens ?? 0)} token · 日均 ${fmtUsd(dailyAverage(series))}${Svg ? ' · 悬停柱子看明细' : ''}`}
        >
          {Svg ? (
            <Chart source={dailySvg(series, full)} alt={`最近 ${seriesDays} 天每日预估成本`} isInteractive />
          ) : (
            <Text color={ACCENT}>
              {sparkline(
                series.map(s => s.usd),
                Math.max(...series.map(s => s.usd)),
              )}
            </Text>
          )}
        </Section>

        {/* 账号 */}
        {view.account === undefined && byAccount.size > 1 ? (
          <Section title="账号">
            {Svg ? (
              <Chart
                source={stackSvg(
                  [...byAccount.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v], i) => ({
                      name: k === 'none' ? '未归属' : accountLabel(accounts, k),
                      value: v,
                      color: ACCOUNT_COLORS[i % ACCOUNT_COLORS.length] ?? BLUE,
                      note: fmtUsd(v),
                    })),
                  full,
                )}
                alt="各账号成本占比"
                isInteractive
              />
            ) : null}
            <Box flexDirection="column">
              {[...byAccount.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([k, v], i) =>
                  legendRow(
                    `acct-${k}`,
                    ACCOUNT_COLORS[i % ACCOUNT_COLORS.length] ?? BLUE,
                    k === 'none' ? '未归属' : accountLabel(accounts, k),
                    fmtUsd(v),
                    pct(v, accountTotal),
                  ),
                )}
            </Box>
          </Section>
        ) : null}

        {/* 更多（默认折叠）：项目、时段与活动明细 */}
        <Box flexDirection="column" gap={2}>
          <Button
            key="toggle-activity"
            label={view.showActivity ? '▾ 更多' : '▸ 更多：项目、时段、工具、命令、技能、模型'}
            plain
            onPress={() => setView(v => ({ ...v, showActivity: !v.showActivity }))}
          />
          {view.showActivity ? (
            <Box flexDirection="column" gap={3}>
              {/* 项目 + 时段 */}
              <Box flexDirection="row" flexWrap="wrap" columnGap={4} rowGap={3}>
                <Box flexDirection="column" flexGrow={1} minWidth={30}>
                  <Section title="项目" note={rankNote(projRows.length, '按成本')}>
                    {rankBlock('proj', projRows, v => fmtUsd(v))}
                  </Section>
                </Box>
                <Box flexDirection="column" flexGrow={1} minWidth={30}>
                  <Section title="时段" note={total.req > 0 ? `最忙 ${busiest}:00–${busiest + 1}:00` : undefined}>
                    {Svg ? (
                      <Chart source={hoursSvg(total.hours, half)} alt="按小时的请求分布" isInteractive />
                    ) : (
                      <Text color={ACCENT}>{sparkline(hourVals, Math.max(1, ...hourVals))}</Text>
                    )}
                  </Section>
                </Box>
              </Box>
              <Box flexDirection="row" flexWrap="wrap" columnGap={4} rowGap={3}>
                <Box flexDirection="column" flexGrow={1} minWidth={30}>
                  <Section
                    title="工具调用"
                    note={rankNote(toolRows.length)}
                    right={
                      <Button
                        key="toggle-mcp"
                        label={view.expandMcp ? '合并 MCP' : '展开 MCP'}
                        plain
                        dimColor
                        onPress={() => setView(v => ({ ...v, expandMcp: !v.expandMcp }))}
                      />
                    }
                  >
                    {rankBlock('tool', toolRows, count)}
                  </Section>
                </Box>
                <Box flexDirection="column" flexGrow={1} minWidth={30}>
                  <Section title="命令" note={rankNote(progRows.length)}>
                    {rankBlock('prog', progRows, count)}
                  </Section>
                </Box>
              </Box>
              <Box flexDirection="row" flexWrap="wrap" columnGap={4} rowGap={3}>
                <Box flexDirection="column" flexGrow={1} minWidth={30}>
                  <Section title="技能" note={rankNote(skillRows.length)}>
                    {rankBlock('skill', skillRows, count)}
                  </Section>
                </Box>
                <Box flexDirection="column" flexGrow={1} minWidth={30}>
                  <Section title="模型" note={rankNote(modelRows.length, '按请求数')}>
                    {rankBlock('model', modelRows, count)}
                  </Section>
                </Box>
              </Box>
            </Box>
          ) : null}
        </Box>

        <Text dimColor size="caption">
          等价 API 成本＝这些用量按 API 标价折算的价值；订阅用户不按它计费，真正的上限看订阅额度。
          取各会话日志记录的总成本，按标价比例分摊到每天和每一类；进行中的会话按同模型已结束会话的单价估算，标「≈」
          {unpriced > 0 ? `；${unpriced} 个会话无法估价` : ''}。数据来自本机 ~/.claude/projects。
        </Text>
      </Box>
    )
}

/**
 * 双击非当前会话后看到的上下文：从它的日志还原。
 * 窗口里各类内容的构成（系统提示词、工具定义……）只有运行中的会话才拿得到，这里不显示。
 */
export async function renderSessionDetail($: EngineInterface, e: PaneInput, id: string): Promise<JSX.Element> {
  const els = $.ui.resolve(e)
  const { Box, Text } = els
  const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
  const aggs = await read($, sessionsAtom)
  const accounts = await read($, accountsAtom)
  const detail = await read($, detailAtom)
  const now = await $.clock.now()
  const { full } = paneWidths(e.props.bodyColumns)

  const all = mergeSessions(aggs)
  const s = all.find(x => x.id === id)
  const file = aggs.find(a => a.id === id && !a.isSub)?.file
  // 面板重载后状态还在、但详情可能是别的会话的：补发一次加载
  if ((detail === null || detail.id !== id) && file && requestedDetail !== id) {
    requestedDetail = id
    void loadSessionDetail($, id, file)
  }
  const d = detail && detail.id === id ? detail : undefined
  const totals = s ? addSession(emptyTotals(), s, undefined) : undefined
  const prompted = totals ? totals.in + totals.cr + totals.cw : 0
  const account = accounts.bySession[id]
  const firstDay = s ? Object.keys(s.days).sort()[0] : undefined
  // 历史会话不知道当时的窗口大小：超过 200k 说明是 1M 窗口
  const window = d && d.maxCtx > 200_000 ? 1_000_000 : 200_000

  const Section = (props: { title: string; note?: string; children?: unknown }) => (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Text weight="semibold">{props.title}</Text>
        {props.note ? (
          <Text dimColor size="footnote">
            {props.note}
          </Text>
        ) : null}
      </Box>
      {props.children as JSX.Element}
    </Box>
  )
  const stat = (label: string, value: string) => (
    <Box flexDirection="column" minWidth={10}>
      <Text dimColor size="caption">
        {label}
      </Text>
      <Text weight="semibold" tabular>
        {value}
      </Text>
    </Box>
  )

  if (!s) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text dimColor>找不到这个会话的日志，可能已被删除。</Text>
      </Box>
    )
  }

  const pctLoaded = d && d.totalBytes > 0 ? Math.round((d.doneBytes / d.totalBytes) * 100) : 0
  const trend = d ? d.requests.map(r => r.ctx) : []
  const topFiles = d
    ? Object.entries(d.files)
        .sort((a, b) => b[1].r + b[1].w - (a[1].r + a[1].w))
        .slice(0, 5)
    : []

  return (
    <Box flexDirection="column" gap={3} paddingX={1} paddingY={1}>
      {/* 标题 */}
      <Box flexDirection="column">
        <Text size="heading" weight="semibold" wrap="truncate-end">
          {s.title}
        </Text>
        <Text dimColor size="footnote" wrap="truncate-end">
          {account ? `${accountLabel(accounts, account).replace('（当前）', '')} · ` : ''}
          {s.project}
          {firstDay ? ` · ${firstDay} 开始` : ''} · 最近 {fmtAgo(now - s.lastAt)}
          {d?.model ? ` · ${d.model}` : ''}
        </Text>
      </Box>

      {/* 上下文 */}
      {!d || d.status === 'loading' ? (
        <Text dimColor>正在读取会话日志 {pctLoaded}%…</Text>
      ) : d.status === 'error' ? (
        <Text color={ORANGE}>读取失败：{d.error}</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="flex-end" columnGap={2}>
            <Text size="heading" weight="medium" tabular>
              最后上下文 {pct(d.lastCtx, window)}
            </Text>
            <Text dimColor tabular>
              {fmtTokens(d.lastCtx)} / {fmtTokens(window)}
            </Text>
          </Box>
          {Svg ? (
            <Svg
              source={stackSvg(
                [
                  { name: '最后上下文', value: d.lastCtx, color: ACCENT, note: fmtTokens(d.lastCtx) },
                  { name: '剩余', value: Math.max(0, window - d.lastCtx), color: 'track' },
                ],
                full,
              )}
              alt="最后一次请求的上下文占用"
              height={Math.ceil(10 * 1.04) + 2}
              isInteractive
            />
          ) : (
            <Text color={ACCENT}>{textBar((d.lastCtx / window) * 100, 30)}</Text>
          )}
          <Text dimColor size="footnote">
            峰值 {fmtTokens(d.maxCtx)} · {d.requestCount} 次请求 · 上下文骤降（压缩或清空）{d.compactions} 次 · 窗口按{' '}
            {fmtTokens(window)} 估算
          </Text>
        </Box>
      )}

      {/* 趋势 */}
      {d && d.status === 'ready' && trend.length >= 2 ? (
        <Section
          title="上下文趋势"
          note={`${d.requestCount} 次请求${d.requestCount > d.requests.length ? `，抽样 ${d.requests.length} 个点` : ''}`}
        >
          {Svg ? (
            <Svg
              source={contextTrendSvg(trend, window, undefined, full)}
              alt="逐请求上下文大小"
              height={Math.ceil(svgSize(contextTrendSvg(trend, window, undefined, full)).height * 1.04) + 2}
              isInteractive
            />
          ) : (
            <Text color={ACCENT}>{sparkline(trend.slice(-60), window)}</Text>
          )}
        </Section>
      ) : null}

      {/* 用量 */}
      {totals ? (
        <Section title="用量">
          <Box flexDirection="row" flexWrap="wrap" columnGap={3} rowGap={1}>
            {stat('等价 API 成本', s.costUsd === undefined ? '—' : `${s.isEstimated ? '≈ ' : ''}${fmtUsd(totals.usd)}`)}
            {stat('Token 消耗', fmtTokens(tokensOf(totals)))}
            {stat('提问', String(totals.prompts))}
            {stat('缓存命中', pct(totals.cr, prompted))}
            {stat('输出', fmtTokens(totals.out))}
          </Box>
        </Section>
      ) : null}

      {/* 活动 */}
      {d && d.status === 'ready' && Object.keys(d.tools).length > 0 ? (
        <Section title="活动" note={`${Object.values(d.tools).reduce((a, b) => a + b, 0)} 次工具调用`}>
          <Text>
            {topEntries(groupTools(d.tools), 5)
              .map(([k, v]) => `${k} ${v}`)
              .join(' · ')}
          </Text>
          {topFiles.length > 0 ? (
            <Box flexDirection="column">
              {topFiles.map(([p, f]) => (
                <Box key={`dfile-${p}`} flexDirection="row" justifyContent="space-between" columnGap={2}>
                  <Text wrap="truncate-start">{p.split('/').slice(-2).join('/')}</Text>
                  <Text tabular dimColor>
                    {[f.r > 0 ? `读 ${f.r}` : '', f.w > 0 ? `写 ${f.w}` : ''].filter(Boolean).join(' · ')}
                  </Text>
                </Box>
              ))}
            </Box>
          ) : null}
          {Object.keys(d.programs).length > 0 ? (
            <Text dimColor size="footnote">
              命令：
              {topEntries(d.programs, 8)
                .map(([k, v]) => `${k}×${v}`)
                .join('  ')}
            </Text>
          ) : null}
        </Section>
      ) : null}

      <Text dimColor size="caption">
        历史会话从日志还原：上下文大小来自每次请求的输入 token；窗口里各类内容的构成只有运行中的会话才拿得到。
      </Text>
    </Box>
  )
}
