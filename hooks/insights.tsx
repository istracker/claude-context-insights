// 跨会话洞察：汇总 ~/.claude/projects 下所有会话的用量、成本与活动
import type { EngineInterface, RenderInput } from 'claude-code'

import type {
  AccountMap,
  DayAgg,
  FileFilter,
  InsightRange,
  InsightSort,
  InsightView,
  RankKind,
  RateSnapshot,
  RateWindow,
  SessionAgg,
} from '../types'
import { dayKey, loadSessionDetail, runScan } from './scan'
import {
  COMMAND,
  getAccounts,
  getDetail,
  getLimits,
  getScan,
  getSessions,
  getView,
  LIMITS_STORE_KEY,
  readLiveLimits,
  setFocus,
  setLimits,
  setViewState,
} from './state'
import {
  ACCENT,
  AMBER,
  BLUE,
  GREY,
  ORANGE,
  PALETTE,
  TEAL,
  contextTrendSvg,
  dailyAverage,
  dailySvg,
  donutSvg,
  heatmapSvg,
  hoursSvg,
  lineSvg,
  stackSvg,
  svgSize,
} from './charts'
import type { DayPoint, HeatDay } from './charts'
import {
  addCount,
  cacheReadFactor,
  cardStyle,
  filterFiles,
  fmtAgo,
  fmtClockTime,
  fmtDayAgo,
  fmtTokens,
  fmtUntil,
  fmtUsd,
  paneWidths,
  pct,
  sameAccountWindows,
  sessionAccount,
  shortFilePath,
  sparkline,
  textBar,
  topEntries,
  windowLabel,
} from './util'

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
  await setViewState($, v => ({ ...v, fileFilter: undefined, showAllFiles: false }))
  await setFocus($, () => id)
  const current = await $.session.id().catch(() => undefined)
  if (id !== current && file) {
    requestedDetail = id
    void loadSessionDetail($, id, file)
  }
}
/** 「上下文」面板里渲染函数的输入 */
export type PaneInput = RenderInput<'Pane'>
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
 * 各类 token 相对「输入」单价的倍数：
 * 5 分钟缓存写 1.25×、1 小时缓存写 2×、缓存读按模型（Opus/Sonnet 5.5 为 0.05×，4.x/Haiku 为 0.1×）、输出 5×。
 * 用来把会话总成本（cost-state）摊到每一天、每一类。
 */
export function partWeights(d: DayAgg, model?: string): Record<Part, number> {
  const m = model ?? topEntries(d.models, 1)[0]?.[0]
  return {
    in: d.in,
    cw: Math.max(0, d.cw - d.cw1h) * 1.25 + d.cw1h * 2,
    cr: d.cr * cacheReadFactor(m),
    out: d.out * 5,
  }
}

function weight(d: DayAgg, model?: string): number {
  const w = partWeights(d, model)
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
  const out: Record<string, number> = { ...a }
  for (const [k, v] of Object.entries(b)) addCount(out, k, v)
  return out
}

function mergeMapInPlace(target: Record<string, number>, b: Record<string, number>): void {
  for (const [k, v] of Object.entries(b)) addCount(target, k, v)
}

function mergeDay(a: DayAgg | undefined, b: DayAgg): DayAgg {
  if (!a) {
    return {
      ...b,
      models: { ...b.models },
      tools: { ...b.tools },
      skills: { ...b.skills },
      programs: { ...b.programs },
      hours: { ...b.hours },
    }
  }
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
  for (const a of aggs) {
    const list = byId.get(a.id)
    if (list) list.push(a)
    else byId.set(a.id, [a])
  }

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
    const models: Record<string, number> = {}
    for (const d of Object.values(days)) mergeMapInPlace(models, d.models)
    const model = topEntries(models, 1)[0]?.[0] ?? 'unknown'
    groups.push({ id, main, days, lastAt, model, subW })
  }

  // 学习每个模型的「美元 / 计费权重」。
  // cost-state 的总成本包含子 Agent 的花费，而 costAtWeight 只是主会话的权重：
  // 有子 Agent 的会话直接拿来学会把单价抬高。所以优先只用没有子 Agent 的会话（口径干净）；
  // 某个模型只有带子 Agent 的样本时，才退而用它们，并把子 Agent 权重算进分母。
  const clean = new Map<string, { usd: number; w: number }>()
  const mixed = new Map<string, { usd: number; w: number }>()
  for (const g of groups) {
    const mainW = g.main.isSub ? 0 : (g.main.costAtWeight ?? 0)
    if (g.main.costUsd === undefined || mainW <= 0) continue
    const target = g.subW > 0 ? mixed : clean
    const w = mainW + g.subW
    for (const k of [g.model, '*']) {
      const cur = target.get(k) ?? { usd: 0, w: 0 }
      target.set(k, { usd: cur.usd + g.main.costUsd, w: cur.w + w })
    }
  }
  const rateOf = (model: string): number | undefined => {
    const r = clean.get(model) ?? mixed.get(model) ?? clean.get('*') ?? mixed.get('*')
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
    const totalW = Object.values(days).reduce((s, d) => s + weight(d, model), 0)
    const dayUsd: Record<string, number> = {}
    if (cost !== undefined && totalW > 0) {
      for (const [k, d] of Object.entries(days)) dayUsd[k] = (cost * weight(d, model)) / totalW
    }
    const cwd = main.cwd
    out.push({
      id,
      title: main.title ?? main.lastPrompt ?? id.slice(0, 8),
      project: cwd ? (cwd.split(/[/\\]/).filter(Boolean).slice(-1)[0] ?? cwd) : '未知项目',
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
    mergeMapInPlace(t.models, d.models)
    mergeMapInPlace(t.tools, d.tools)
    mergeMapInPlace(t.skills, d.skills)
    mergeMapInPlace(t.programs, d.programs)
    mergeMapInPlace(t.hours, d.hours)
  }
  return own
}

/** MCP 工具按服务合并：mcp__Claude_Browser__computer → Claude_Browser（MCP） */
/** MCP 服务名：连接器用 UUID 命名，显示成「连接器 1a59」 */
export function serverLabel(server: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(server) ? `连接器 ${server.slice(0, 4)}` : server
}

export function groupTools(tools: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, n] of Object.entries(tools)) {
    const m = /^mcp__(.+?)__/.exec(name)
    addCount(out, m ? `${serverLabel(m[1] ?? '')}（MCP）` : name, n)
  }
  return out
}

export function shortTool(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${serverLabel(m[1] ?? '')} · ${m[2]}` : name
}

/** 工具在排行里的名字：MCP 工具默认按服务合并 */
export function toolKey(name: string, expandMcp: boolean): string {
  if (expandMcp) return shortTool(name)
  const m = /^mcp__(.+?)__/.exec(name)
  return m ? `${serverLabel(m[1] ?? '')}（MCP）` : name
}

/** 排行的一项：数值、最近用到的日期（YYYY-MM-DD）、用过它的会话 */
export type RankItem = { value: number; lastDay: string; ids: Set<string> }

/**
 * 把会话在这段时间里的项目、工具、命令、技能、模型汇总成排行。
 * 日志只按天记次数，所以「最近」精确到当天（YYYY-MM-DD）。
 */
export function rankIndex(
  sessions: MergedSession[],
  days: Set<string> | undefined,
  expandMcp: boolean,
): Record<RankKind, Map<string, RankItem>> {
  const out: Record<RankKind, Map<string, RankItem>> = {
    proj: new Map(),
    tool: new Map(),
    prog: new Map(),
    skill: new Map(),
    model: new Map(),
  }
  const add = (kind: RankKind, key: string, value: number, day: string, id: string) => {
    const it = out[kind].get(key) ?? { value: 0, lastDay: '', ids: new Set<string>() }
    it.value += value
    if (day > it.lastDay) it.lastDay = day
    it.ids.add(id)
    out[kind].set(key, it)
  }
  for (const s of sessions) {
    for (const [k, d] of Object.entries(s.days)) {
      if (days && !days.has(k)) continue
      // 项目按成本排行：只有产生费用的才计入，避免抬头项目数与列表「暂无」不一致
      const usd = s.dayUsd[k] ?? 0
      if (usd > 0) add('proj', s.project, usd, k, s.id)
      for (const [name, n] of Object.entries(d.tools)) if (n > 0) add('tool', toolKey(name, expandMcp), n, k, s.id)
      for (const [name, n] of Object.entries(d.programs)) if (n > 0) add('prog', name, n, k, s.id)
      for (const [name, n] of Object.entries(d.skills)) if (n > 0) add('skill', name, n, k, s.id)
      for (const [name, n] of Object.entries(d.models)) if (n > 0) add('model', name, n, k, s.id)
    }
  }
  return out
}

/** 会话列表按项目分组胶囊：按会话数降序（同数按成本降序），取前 limit 个；若已选中项不在前 limit 个中则补上 */
export function projectChips(
  sessions: { project: string; r: { usd: number } }[],
  selected?: string,
  limit = 8,
): { name: string; count: number }[] {
  const byProj = new Map<string, { count: number; usd: number }>()
  for (const s of sessions) {
    const cur = byProj.get(s.project) ?? { count: 0, usd: 0 }
    cur.count += 1
    cur.usd += s.r.usd
    byProj.set(s.project, cur)
  }
  const ranked = [...byProj.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].usd - a[1].usd || a[0].localeCompare(b[0]))
    .map(([name, v]) => ({ name, count: v.count }))
  const top = ranked.slice(0, limit)
  if (selected !== undefined && !top.some(p => p.name === selected)) {
    const hit = ranked.find(p => p.name === selected) ?? { name: selected, count: 0 }
    top.push(hit)
  }
  return top
}

/** 轻量分页：自动把页码钳在合法范围，避免筛选或扫描后越界 */
export function paginate<T>(items: T[], rawPage: number | undefined, pageSize: number): {
  page: number
  totalPages: number
  slice: T[]
} {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const page = Math.max(0, Math.min(rawPage ?? 0, totalPages - 1))
  return { page, totalPages, slice: items.slice(page * pageSize, (page + 1) * pageSize) }
}

/** 汇总所有按天活跃度（用于日历热力图）并计算近 30 天活跃天数与当前连续活跃天数 */
export function buildHeatMap(
  sessions: MergedSession[],
  today: string,
): { byDay: Record<string, HeatDay>; active30: number; streak: number } {
  const byDay: Record<string, HeatDay> = {}
  for (const s of sessions) {
    for (const [k, d] of Object.entries(s.days)) {
      const tok = tokensOf(d)
      if (tok <= 0 && d.req <= 0) continue
      const cur = byDay[k] ?? { usd: 0, tokens: 0, sessions: 0 }
      cur.usd += s.dayUsd[k] ?? 0
      cur.tokens += tok
      cur.sessions += 1
      byDay[k] = cur
    }
  }
  const todayMs = Date.parse(today + 'T00:00:00Z')
  if (Number.isNaN(todayMs)) return { byDay, active30: 0, streak: 0 }
  const keyAt = (ago: number) => new Date(todayMs - ago * DAY_MS).toISOString().slice(0, 10)
  let active30 = 0
  for (let i = 0; i < 30; i++) if ((byDay[keyAt(i)]?.tokens ?? 0) > 0) active30 += 1
  // 连续活跃：今天有活动就从今天往前数，今天还没活动就从昨天往前数
  let streak = 0
  const startAgo = (byDay[keyAt(0)]?.tokens ?? 0) > 0 ? 0 : 1
  for (let i = startAgo; i < 365; i++) {
    if ((byDay[keyAt(i)]?.tokens ?? 0) > 0) streak += 1
    else break
  }
  return { byDay, active30, streak }
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
const PREV_TITLE: Record<InsightRange, string> = { today: '昨天', '7d': '前 7 天', '30d': '前 30 天', all: '' }
const SORTS: [InsightSort, string][] = [
  ['recent', '按时间'],
  ['cost', '按成本'],
]
/** 每类成本是什么，只给占比最高的一类显示 */
const PART_HINT: Record<Part, string> = {
  cw: '上下文变化后要重新写入缓存，单价是输入的 1.25～2 倍',
  out: '模型生成的回复与工具调用参数，单价最高',
  cr: '复用已缓存的上下文，单价仅为输入的 1/20～1/10',
  in: '没有命中缓存的输入',
}
const ACCOUNT_COLORS = PALETTE
/** 排行：默认显示几行、展开后最多几行 */
const RANK_VISIBLE = 6
const RANK_MAX = 20
/** 排行点选的对象在会话筛选提示里怎么称呼 */
const RANK_NOUN: Record<RankKind, string> = { proj: '项目', tool: '工具', prog: '命令', skill: '技能', model: '模型' }

// ---------- 注册 ----------

/** 会话开始时调用：注册命令并做一次增量扫描（只读上次之后新增的日志） */
export async function startInsights($: EngineInterface): Promise<void> {
  await $.command.register({
    name: COMMAND,
    description: '打开上下文洞察：本会话的上下文窗口，以及所有会话的额度、成本与活动（加 full 精确统计）',
  })
  // 各账号上次的额度读数存在 $.store（跨会话），载入到本会话状态
  const stored = (await $.store.get(LIMITS_STORE_KEY)) as Record<string, RateSnapshot> | undefined
  // 与 refresh 并发：已有的（更新的）读数优先，旧读数只补缺
  if (stored && typeof stored === 'object') await setLimits($, cur => ({ ...stored, ...cur }))
  void runScan($)
}

// /ctx-insights 的处理在 register.tsx（要调用本会话的精确统计）

/** 「洞察」标签页的内容：所有会话的额度、成本、会话与活动 */
export async function renderInsights($: EngineInterface, e: PaneInput): Promise<JSX.Element> {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Select } = els
    // 终端的元素表里也有 Svg，但画不出来：按绘制端判断，终端用文字兜底
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const card = cardStyle(e.surface)
    // 显式给宽高（不给高度时桌面端内嵌框默认 150px）。宽度也要给：不给时宿主会把图放大到铺满面板，
    // 而框高仍按原图算，宽面板下底部（坐标轴、日期）就被裁掉。高度多留 4%，防宽度略估大时被等比缩放后裁底；viewHeight 小于内容高度时，模块内部可上下滑动
    const Chart = (p: { source: string; alt: string; isInteractive?: boolean; viewHeight?: number }) => {
      if (!Svg) return null
      // 注意：JSX 编译成全局 h(...)，局部变量不能叫 h
      const size = svgSize(p.source)
      return (
        <Svg
          source={p.source}
          alt={p.alt}
          width={size.width}
          height={p.viewHeight ?? Math.ceil(size.height * 1.04) + 2}
          isInteractive
        />
      )
    }
    const aggs = await getSessions($)
    const scan = await getScan($)
    const view = await getView($)
    const storedAccounts = await getAccounts($)
    const currentSessionId = await $.session.id().catch(() => undefined)
    // 「当前」以本会话的归属为准（状态里的 current 可能是重新加载插件前算的）
    const accounts: AccountMap = {
      ...storedAccounts,
      current: sessionAccount(storedAccounts, currentSessionId),
    }
    const now = await $.clock.now()
    const tzMin = scan.tzMin ?? -new Date().getTimezoneOffset()
    const today = dayKey(now, tzMin)
    const setView = (fn: (v: InsightView) => InsightView) => void setViewState($, fn)
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
    let unpriced = 0
    const active: (MergedSession & { r: Totals })[] = []
    for (const s of scoped) {
      const r = addSession(total, s, days)
      if (r.req === 0 && r.prompts === 0) continue
      active.push({ ...s, r })
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
    if (view.account === undefined) {
      for (const s of all) {
        let usd = 0
        for (const [k, v] of Object.entries(s.dayUsd)) {
          if (!days || days.has(k)) usd += v
        }
        if (usd <= 0) continue
        const k = s.account ?? 'none'
        byAccount.set(k, (byAccount.get(k) ?? 0) + usd)
      }
    }
    const accountTotal = [...byAccount.values()].reduce((a, b) => a + b, 0)

    // 订阅额度：当前账号取实时读数（短期缓存避免高频重渲染重复 RPC），其他账号取切换前存下的最后读数
    const storedLimits = await getLimits($)
    const liveWindows = await readLiveLimits($, now)
    const currentId = accounts.current ?? 'current'
    type LimitRow = RateSnapshot & { account: string; isLive: boolean }
    const limitRows: LimitRow[] = []
    if (liveWindows.length > 0) limitRows.push({ account: currentId, at: now, windows: liveWindows, isLive: true })
    else if (storedLimits[currentId]) limitRows.push({ ...storedLimits[currentId], account: currentId, isLive: false })
    for (const [k, v] of Object.entries(storedLimits)) {
      if (k === currentId || k === 'current') continue
      // 与实时读数同源（重置时间完全一致）的，是以前存错账号的同一份数据，不当成别的账号显示
      if (liveWindows.length > 0 && sameAccountWindows(v.windows, liveWindows)) continue
      limitRows.push({ ...v, account: k, isLive: false })
    }
    // 「未归属」的会话不属于任何账号，没有额度可显示
    const shownLimits = view.account === undefined ? limitRows : limitRows.filter(r => r.account === view.account)

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
    // 排行：次数、最近用到的日期与用过它的会话；点选一项后下方会话列表只列符合条件的会话
    const ranks = rankIndex(active, days, view.expandMcp ?? false)
    // 兼容旧状态：项目筛选统一归入 activeProject，其余排行（工具/命令/技能/模型）归入 activePick，两者可叠加
    const activeProject = view.project ?? (view.pick?.kind === 'proj' ? view.pick.key : undefined)
    const activePick = view.pick && view.pick.kind !== 'proj' ? view.pick : undefined
    const pickedIds = activePick ? (ranks[activePick.kind].get(activePick.key)?.ids ?? new Set<string>()) : undefined
    const sorted = [...active]
      .filter(s => (activeProject === undefined || s.project === activeProject) && (pickedIds === undefined || pickedIds.has(s.id)))
      .sort((a, b) => (view.sort === 'cost' ? b.r.usd - a.r.usd : b.lastAt - a.lastAt))
    /** 会话 id → 主日志文件（双击后从它还原上下文） */
    const mainFiles = new Map(aggs.filter(a => !a.isSub).map(a => [a.id, a.file] as const))
    const PAGE_SIZE = 6
    const { page, totalPages, slice: shownSessions } = paginate(sorted, view.page, PAGE_SIZE)
    const projChips = projectChips(active, activeProject)
    // 宽屏下把「钱花在哪」与「每日成本」并排，压缩纵向滚动长度
    const isWideCharts = e.props.bodyColumns >= 84
    const chartColWidth = isWideCharts ? half : full
    const donutRow = chartColWidth >= 320
    const showPartTokens = !isWideCharts || chartColWidth >= 420
    const showAccounts = view.account === undefined && byAccount.size > 1
    const heat = buildHeatMap(scoped, today)

    // ----- 小组件 -----
    /** 区块卡片：标题 · 旁注 ··· 右上角关键数字 · 操作 */
    const Section = (props: {
      title: string
      note?: string
      stat?: string
      right?: JSX.Element | null
      children?: unknown
    }) => (
      <Box flexDirection="column" gap={1} {...card}>
        <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={2}>
          <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={1}>
            <Text weight="semibold">{props.title}</Text>
            {props.note ? (
              <Text dimColor size="footnote">
                {props.note}
              </Text>
            ) : null}
          </Box>
          {props.stat || props.right ? (
            <Box flexDirection="row" columnGap={2} alignItems="center">
              {props.stat ? (
                <Text tabular weight="medium">
                  {props.stat}
                </Text>
              ) : null}
              {props.right ?? null}
            </Box>
          ) : null}
        </Box>
        {props.children as JSX.Element}
      </Box>
    )
    /** KPI 宫格：宽面板 3 列、窄面板 2 列，按行铺满整宽，每格「标签 / 大数字 / 一行小注」 */
    const kpiCols = e.props.bodyColumns >= 72 ? 3 : 2
    const kpi = (key: string, label: string, value: string, note?: { text: string; color?: string }) => (
      <Box key={key} flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} {...card}>
        <Text dimColor size="footnote" wrap="truncate-end">
          {label}
        </Text>
        <Text weight="bold" size="title" tabular wrap="truncate-end">
          {value}
        </Text>
        {note ? (
          <Text size="footnote" color={note.color} dimColor={note.color === undefined} wrap="truncate-end">
            {note.text}
          </Text>
        ) : null}
      </Box>
    )
    /** 环比小注：涨超 5% 橙色、降超 5% 绿色 */
    const changeNote = (change: number | undefined) =>
      change === undefined
        ? undefined
        : {
            text:
              Math.abs(change) < 0.005
                ? `持平 比${PREV_TITLE[view.range]}`
                : `${change > 0 ? '↑' : '↓'} ${Math.abs(change * 100).toFixed(0)}% 比${PREV_TITLE[view.range]}`,
            color: change > 0.05 ? ORANGE : change < -0.05 ? TEAL : undefined,
          }
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
     * 排行：「名称 · 数值 · 最近一次」，下面一条细进度线；点一项筛选下方的会话，再点取消。
     * 默认 RANK_VISIBLE 行，可展开到 RANK_MAX 行。
     */
    const rankList = (kind: RankKind, fmt: (v: number) => string, width = half) => {
      const rows = [...ranks[kind].entries()].filter(([, it]) => it.value > 0).sort((a, b) => b[1].value - a[1].value)
      if (rows.length === 0) return <Text dimColor>暂无</Text>
      const isOpen = view.openRanks?.includes(kind) ?? false
      const max = rows[0]?.[1].value ?? 1
      const isProj = kind === 'proj'
      const pickedHere = isProj ? activeProject !== undefined : activePick?.kind === kind
      return (
        <Box flexDirection="column" gap={1}>
          {rows.slice(0, isOpen ? RANK_MAX : RANK_VISIBLE).map(([k, it], i) => {
            const isPicked = isProj ? activeProject === k : pickedHere && activePick?.key === k
            return (
              <Box key={`rk-${kind}-${k}`} flexDirection="column">
                <Box flexDirection="row" alignItems="center" columnGap={2}>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Button
                      key={`pick-${kind}-${k}`}
                      plain
                      dimColor={pickedHere && !isPicked}
                      onPress={() =>
                        setView(v =>
                          isProj
                            ? {
                                ...v,
                                project: isPicked ? undefined : k,
                                pick: v.pick?.kind === 'proj' ? undefined : v.pick,
                                page: 0,
                              }
                            : { ...v, pick: isPicked ? undefined : { kind, key: k }, page: 0 },
                        )
                      }
                    >
                      <Text wrap="truncate-end" color={isPicked ? ACCENT : undefined} weight={isPicked ? 'semibold' : 'regular'}>
                        {isPicked ? `✓ ${k}` : k}
                      </Text>
                    </Button>
                  </Box>
                  {Svg ? null : <Text color={ACCENT}>{textBar((it.value / max) * 100, 6)}</Text>}
                  <Text tabular>{fmt(it.value)}</Text>
                  <Box minWidth={9} justifyContent="flex-end">
                    <Text dimColor size="footnote" tabular>
                      {fmtDayAgo(it.lastDay, today)}
                    </Text>
                  </Box>
                </Box>
                {Svg ? (
                  <Svg
                    source={lineSvg(it.value / max, width, i === 0 || isPicked ? ACCENT : GREY)}
                    alt={`${k} ${fmt(it.value)}`}
                    width={width}
                    height={4}
                  />
                ) : null}
              </Box>
            )
          })}
          {rows.length > RANK_VISIBLE ? (
            <Button
              key={`open-${kind}`}
              label={
                isOpen
                  ? rows.length > RANK_MAX
                    ? `收起（已显示前 ${RANK_MAX} 项，共 ${rows.length} 项）`
                    : '收起'
                  : rows.length > RANK_MAX
                    ? `显示前 ${RANK_MAX} 项（共 ${rows.length} 项）`
                    : `显示全部 ${rows.length} 项`
              }
              plain
              dimColor
              onPress={() =>
                setView(v => ({
                  ...v,
                  openRanks: isOpen ? (v.openRanks ?? []).filter(x => x !== kind) : [...(v.openRanks ?? []), kind],
                }))
              }
            />
          ) : null}
        </Box>
      )
    }
    /** 排行标题右上角：合计 */
    const rankStat = (kind: RankKind, unit: string) => {
      const sum = [...ranks[kind].values()].reduce((a, it) => a + it.value, 0)
      return sum > 0 ? `${ranks[kind].size} 项 · ${sum} ${unit}` : undefined
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
    const count = (v: number) => `×${v}`
    const toolCalls = Object.values(total.tools).reduce((a, n) => a + n, 0)
    const commandRuns = Object.values(total.programs).reduce((a, n) => a + n, 0)
    const pctDone = scan.totalBytes > 0 ? Math.round((scan.doneBytes / scan.totalBytes) * 100) : 100

    const accountOptions = [
      { value: 'all', label: '全部账号' },
      ...accountIds.map(id => ({ value: id, label: accountLabel(accounts, id) })),
      ...(hasUnassigned ? [{ value: 'none', label: '未归属' }] : []),
    ]

    const kpiItems = [
      kpi(
        'kpi-usd',
        '等价 API 成本',
        fmtUsd(total.usd),
        changeNote(delta) ??
          (unpriced > 0
            ? { text: `${unpriced} 个会话无法估价` }
            : { text: total.usd > 0 ? '按标价折算' : '暂无费用' }),
      ),
      kpi('kpi-tokens', 'Token 消耗', fmtTokens(tokensOf(total)), changeNote(tokenDelta) ?? { text: `${total.req} 次请求` }),
      kpi('kpi-sessions', '会话', String(active.length), { text: `${total.prompts} 次提问` }),
      kpi('kpi-cache', '缓存命中', pct(total.cr, prompted), { text: `读取 ${fmtTokens(total.cr)} token` }),
      kpi(
        'kpi-per-prompt',
        '每次提问',
        total.prompts > 0 ? fmtUsd(total.usd / total.prompts) : '—',
        total.prompts > 0 ? { text: `${fmtTokens(Math.round(tokensOf(total) / total.prompts))} token` } : { text: '暂无提问' },
      ),
      kpi('kpi-tools', '工具调用', String(toolCalls), { text: `命令执行 ${commandRuns} 次` }),
    ]
    const kpiRows: JSX.Element[][] = []
    for (let i = 0; i < kpiItems.length; i += kpiCols) kpiRows.push(kpiItems.slice(i, i + kpiCols))

    const costBreakdownCard = (
      <Section title="钱花在哪" stat={total.usd > 0 ? `合计 ${fmtUsd(total.usd)}` : undefined}>
        <Box flexDirection={Svg && total.usd > 0 && donutRow ? 'row' : 'column'} alignItems={Svg && total.usd > 0 && donutRow ? 'center' : 'stretch'} columnGap={3} rowGap={2}>
          {Svg && total.usd > 0 ? (
            <Chart
              source={donutSvg(
                parts.map(p => ({ name: p.name, value: total.usdBy[p.key], color: p.color, note: `${fmtUsd(total.usdBy[p.key])} · ${fmtTokens(total[p.key])} token` })),
                96,
                { top: fmtUsd(total.usd), sub: '合计' },
              )}
              alt="成本构成"
              isInteractive
            />
          ) : null}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            {parts.map(p =>
              legendRow(
                `part-${p.key}`,
                p.color,
                p.name,
                fmtUsd(total.usdBy[p.key]),
                pct(total.usdBy[p.key], total.usd),
                total.usdBy[p.key] === 0,
                showPartTokens ? `${fmtTokens(total[p.key])} token` : undefined,
              ),
            )}
          </Box>
        </Box>
        {topPart && total.usd > 0 ? (
          <Text dimColor size="footnote">
            {topPart.name}占 {pct(total.usdBy[topPart.key], total.usd)}：{PART_HINT[topPart.key]}。
          </Text>
        ) : null}
      </Section>
    )

    const dailyCostCard = (
      <Section
        title="每日成本"
        note={Svg ? '悬停柱子看明细' : undefined}
        stat={`今天 ${fmtUsd(series[series.length - 1]?.usd ?? 0)} · 日均 ${fmtUsd(dailyAverage(series))}`}
      >
        {Svg ? (
          <Chart source={dailySvg(series, chartColWidth)} alt={`最近 ${seriesDays} 天每日预估成本`} isInteractive />
        ) : (
          <Text color={ACCENT}>
            {sparkline(
              series.map(s => s.usd),
              Math.max(...series.map(s => s.usd)),
            )}
          </Text>
        )}
      </Section>
    )

    const accountsCard = showAccounts ? (
      <Section title="账号" stat={`合计 ${fmtUsd(accountTotal)}`}>
        <Box flexDirection={Svg && donutRow ? 'row' : 'column'} alignItems={Svg && donutRow ? 'center' : 'stretch'} columnGap={3} rowGap={2}>
          {Svg ? (
            <Chart
              source={donutSvg(
                [...byAccount.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v], i) => ({
                    name: k === 'none' ? '未归属' : accountLabel(accounts, k),
                    value: v,
                    color: ACCOUNT_COLORS[i % ACCOUNT_COLORS.length] ?? BLUE,
                    note: fmtUsd(v),
                  })),
                96,
                { top: fmtUsd(accountTotal), sub: `${byAccount.size} 账号` },
              )}
              alt="各账号成本占比"
              isInteractive
            />
          ) : null}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
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
        </Box>
      </Section>
    ) : null

    const heatmapCard = (
      <Section
        title="活跃度"
        note={Svg ? '悬停看当天明细' : undefined}
        stat={
          heat.active30 > 0
            ? `近 30 天活跃 ${heat.active30} 天${heat.streak >= 2 ? ` · 连续 ${heat.streak} 天` : ''}`
            : '近 30 天无活动'
        }
      >
        {Svg ? (
          <Chart source={heatmapSvg(heat.byDay, today, isWideCharts && showAccounts ? half : full)} alt="活跃度热力图" isInteractive />
        ) : (
          <Text dimColor>
            近 30 天活跃 {heat.active30} 天{heat.streak >= 2 ? ` · 连续 ${heat.streak} 天` : ''}
          </Text>
        )}
      </Section>
    )

    // ----- 版面 -----
    return (
      <Box flexDirection="column" gap={4} paddingX={1} paddingY={1}>
        {/* 工具栏 */}
        <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" rowGap={1} columnGap={2}>
          <Box flexDirection="row" columnGap={1}>
            {RANGES.map(([r, label]) => (
              <Button
                key={`range-${r}`}
                label={label}
                variant={view.range === r ? 'primary' : 'secondary'}
                onPress={() => setView(v => ({ ...v, range: r, page: 0 }))}
              />
            ))}
          </Box>
          <Box flexDirection="row" columnGap={2} alignItems="center">
            {accountIds.length > 0 ? (
              <Select
                key="account"
                options={accountOptions}
                value={view.account ?? 'all'}
                onSelect={value => setView(v => ({ ...v, account: value === 'all' ? undefined : value, page: 0 }))}
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
          note={
            shownLimits.length === 0
              ? view.account === 'none'
                ? '未归属的会话没有对应账号的额度'
                : '发一条消息后显示'
              : undefined
          }
          stat={shownLimits[0]?.isLive ? '实时' : undefined}
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

        {/* KPI 宫格：一眼看清这段时间的规模、效率与活动量 */}
        <Box flexDirection="column" gap={2}>
          {kpiRows.map((cells, i) => (
            <Box key={`kpi-row-${i}`} flexDirection="row" columnGap={2}>
              {cells}
            </Box>
          ))}
          {scan.isRunning ? (
            <Text dimColor size="footnote">
              正在读取会话日志 {scan.doneFiles}/{scan.totalFiles}，数字会随扫描增加
            </Text>
          ) : null}
        </Box>

        {/* 排行与分布（默认折叠）：放在会话正上方，点选一项后下方会话即时筛选 */}
        <Box flexDirection="column" gap={2}>
          <Button
            key="toggle-activity"
            label={view.showActivity ? '▾ 更多' : '▸ 更多：项目、时段、工具、命令、技能、模型'}
            plain
            onPress={() => setView(v => ({ ...v, showActivity: !v.showActivity }))}
          />
          {view.showActivity ? (
            <Text dimColor size="footnote">
              点排行里的一项，下方「会话」只列出用过它的会话；再点一次取消。「最近」按天记录，精确到当天。
            </Text>
          ) : null}
          {view.showActivity ? (
            <Box flexDirection="column" gap={4}>
              {/* 项目 + 时段 */}
              <Box flexDirection="row" flexWrap="wrap" columnGap={4} rowGap={4}>
                <Box flexDirection="column" flexGrow={1} minWidth={30}>
                  <Section title="项目" note="按成本" stat={ranks.proj.size > 0 ? `${ranks.proj.size} 个` : undefined}>
                    {rankList('proj', v => fmtUsd(v))}
                  </Section>
                </Box>
                <Box flexDirection="column" flexGrow={1} minWidth={30}>
                  <Section title="时段" stat={total.req > 0 ? `最忙 ${busiest}:00–${busiest + 1}:00` : undefined}>
                    {Svg ? (
                      <Chart source={hoursSvg(total.hours, half)} alt="按小时的请求分布" isInteractive />
                    ) : (
                      <Text color={ACCENT}>{sparkline(hourVals, Math.max(1, ...hourVals))}</Text>
                    )}
                  </Section>
                </Box>
              </Box>
              <Box flexDirection="row" flexWrap="wrap" columnGap={4} rowGap={4}>
                <Box flexDirection="column" flexGrow={1} minWidth={30}>
                  <Section
                    title="工具调用"
                    stat={rankStat('tool', '次')}
                    right={
                      <Button
                        key="toggle-mcp"
                        label={view.expandMcp ? '合并 MCP' : '展开 MCP'}
                        plain
                        dimColor
                        onPress={() =>
                          setView(v => ({
                            ...v,
                            expandMcp: !v.expandMcp,
                            // 合并/展开后工具名变了，原来点选的工具对不上
                            pick: v.pick?.kind === 'tool' ? undefined : v.pick,
                            page: v.pick?.kind === 'tool' ? 0 : v.page,
                          }))
                        }
                      />
                    }
                  >
                    {rankList('tool', count)}
                  </Section>
                </Box>
                <Box flexDirection="column" flexGrow={1} minWidth={30}>
                  <Section title="命令" stat={rankStat('prog', '次')}>
                    {rankList('prog', count)}
                  </Section>
                </Box>
              </Box>
              <Box flexDirection="row" flexWrap="wrap" columnGap={4} rowGap={4}>
                <Box flexDirection="column" flexGrow={1} minWidth={30}>
                  <Section title="技能" stat={rankStat('skill', '次')}>
                    {rankList('skill', count)}
                  </Section>
                </Box>
                <Box flexDirection="column" flexGrow={1} minWidth={30}>
                  <Section title="模型" note="按请求数" stat={rankStat('model', '次')}>
                    {rankList('model', count)}
                  </Section>
                </Box>
              </Box>
            </Box>
          ) : null}
        </Box>

        {/* 会话 */}
        <Section
          title="会话"
          note={
            activeProject && activePick
              ? `${sorted.length} 个 · 项目「${activeProject}」且用过${RANK_NOUN[activePick.kind]}「${activePick.key}」`
              : activePick
                ? `${sorted.length} 个用过${RANK_NOUN[activePick.kind]}「${activePick.key}」`
                : activeProject
                  ? `${sorted.length} 个 · 项目「${activeProject}」· 双击查看上下文`
                  : active.length > 0
                    ? `${active.length} 个 · 双击查看会话的上下文`
                    : undefined
          }
          right={
            <Box flexDirection="row" columnGap={1}>
              {SORTS.map(([s, label]) => (
                <Button
                  key={`sort-${s}`}
                  label={label}
                  plain
                  dimColor={view.sort !== s}
                  onPress={() => setView(v => ({ ...v, sort: s, page: 0 }))}
                />
              ))}
            </Box>
          }
        >
          {/* 项目分组胶囊：至少两个项目或已选中项目时显示，与「项目」排行联动 */}
          {projChips.length >= 2 || activeProject !== undefined ? (
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
              <Button
                key="proj-all"
                label={`全部 ${active.length}`}
                variant={activeProject === undefined ? 'primary' : 'secondary'}
                onPress={() =>
                  setView(v => ({
                    ...v,
                    project: undefined,
                    pick: v.pick?.kind === 'proj' ? undefined : v.pick,
                    page: 0,
                  }))
                }
              />
              {projChips.map(p => (
                <Button
                  key={`proj-${p.name}`}
                  label={`${p.name} ${p.count}`}
                  variant={activeProject === p.name ? 'primary' : 'secondary'}
                  onPress={() =>
                    setView(v => ({
                      ...v,
                      project: activeProject === p.name ? undefined : p.name,
                      pick: v.pick?.kind === 'proj' ? undefined : v.pick,
                      page: 0,
                    }))
                  }
                />
              ))}
            </Box>
          ) : null}
          {activePick ? (
            <Button
              key="clear-pick"
              label={`✕ 清除筛选（${RANK_NOUN[activePick.kind]}：${activePick.key}）`}
              plain
              dimColor
              onPress={() => setView(v => ({ ...v, pick: undefined, page: 0 }))}
            />
          ) : null}
          {active.length === 0 ? (
            <Text dimColor>{scan.isRunning ? '正在扫描…' : '这段时间没有会话。'}</Text>
          ) : (activeProject !== undefined || activePick !== undefined) && sorted.length === 0 ? (
            <Text dimColor>这段时间没有符合筛选条件的会话。</Text>
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
          {totalPages > 1 ? (
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
              <Button
                key="page-prev"
                label="‹ 上一页"
                plain
                dimColor={page === 0}
                onPress={() => {
                  if (page > 0) setView(v => ({ ...v, page: page - 1 }))
                }}
              />
              <Text dimColor size="footnote" tabular>
                第 {page + 1} / {totalPages} 页 · 共 {sorted.length} 个
              </Text>
              <Button
                key="page-next"
                label="下一页 ›"
                plain
                dimColor={page >= totalPages - 1}
                onPress={() => {
                  if (page < totalPages - 1) setView(v => ({ ...v, page: page + 1 }))
                }}
              />
            </Box>
          ) : null}
        </Section>

        {/* 钱花在哪 + 每日成本：宽屏双列并排，窄屏自动单列 */}
        {isWideCharts ? (
          <Box flexDirection="row" columnGap={3}>
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              {costBreakdownCard}
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              {dailyCostCard}
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" gap={4}>
            {costBreakdownCard}
            {dailyCostCard}
          </Box>
        )}

        {/* 账号 + 活跃度热力图：多账号且宽屏时双列并排 */}
        {isWideCharts && showAccounts ? (
          <Box flexDirection="row" columnGap={3}>
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              {accountsCard}
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              {heatmapCard}
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" gap={4}>
            {accountsCard}
            {heatmapCard}
          </Box>
        )}

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
  const { Box, Text, Button } = els
  const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
  const card = cardStyle(e.surface)
  const aggs = await getSessions($)
  const accounts = await getAccounts($)
  const detail = await getDetail($)
  const scan = await getScan($)
  const view = await getView($)
  const now = await $.clock.now()
  const tzMin = scan.tzMin ?? -new Date().getTimezoneOffset()
  const cols = e.props.bodyColumns
  const { full } = paneWidths(cols)
  const setView = (fn: (v: InsightView) => InsightView) => void setViewState($, fn)

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

  const Section = (props: { title: string; note?: string; right?: JSX.Element | null; children?: unknown }) => (
    <Box flexDirection="column" gap={1} {...card}>
      <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={2}>
        <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={1}>
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
  const trendSvg = Svg && d && d.status === 'ready' && trend.length >= 2 ? contextTrendSvg(trend, window, undefined, full) : undefined
  const trendSize = trendSvg ? svgSize(trendSvg) : undefined
  const drops = d?.drops ?? []
  const fileFilter: FileFilter = view.fileFilter ?? 'all'
  const allFileEntries = d ? Object.entries(d.files) : []
  const readFileCount = allFileEntries.filter(([, f]) => f.r > 0).length
  const writeFileCount = allFileEntries.filter(([, f]) => f.w > 0).length
  const filteredFiles = d ? filterFiles(d.files, fileFilter) : []
  const FILES_VISIBLE = 6
  const FILES_MAX = 30
  const shownFiles = view.showAllFiles ? filteredFiles.slice(0, FILES_MAX) : filteredFiles.slice(0, FILES_VISIBLE)
  const fileFilters: [FileFilter, string][] = [
    ['all', `全部 ${allFileEntries.length}`],
    ['read', `读 ${readFileCount}`],
    ['write', `写 ${writeFileCount}`],
  ]

  return (
    <Box flexDirection="column" gap={4} paddingX={1} paddingY={1}>
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
      {!file ? (
        // 主日志已被删、只剩子 Agent 日志：没有可还原的上下文，不能一直停在「读取中」
        <Box flexDirection="column" {...card}>
          <Text dimColor>主会话日志已不存在，无法还原上下文，下方只有子 Agent 的用量。</Text>
        </Box>
      ) : !d || d.status === 'loading' ? (
        <Box flexDirection="column" {...card}>
          <Text dimColor>正在读取会话日志 {pctLoaded}%…</Text>
        </Box>
      ) : d.status === 'error' ? (
        <Box flexDirection="column" {...card}>
          <Text color={ORANGE}>读取失败：{d.error}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" gap={1} {...card}>
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
              width={full}
              height={Math.ceil(10 * 1.04) + 2}
              isInteractive
            />
          ) : (
            <Text color={ACCENT}>{textBar((d.lastCtx / window) * 100, Math.max(10, Math.min(40, cols - 4)))}</Text>
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
          {Svg && trendSvg && trendSize ? (
            <Svg
              source={trendSvg}
              alt="逐请求上下文大小"
              width={trendSize.width}
              height={Math.ceil(trendSize.height * 1.04) + 2}
              isInteractive
            />
          ) : (
            <Text color={ACCENT}>{sparkline(trend.slice(-Math.max(10, cols - 4)), window)}</Text>
          )}
        </Section>
      ) : null}

      {/* 上下文事件（骤降明细） */}
      {d && d.status === 'ready' && drops.length > 0 ? (
        <Section
          title="上下文事件"
          note={`压缩或清空 · 共 ${drops.length} 次${drops.length > 10 ? '（显示最近 10 次）' : ''}`}
        >
          <Box flexDirection="column" gap={1}>
            {drops
              .slice(-10)
              .reverse()
              .map(ev => (
                <Box key={`drop-${ev.step}-${ev.at}`} flexDirection="row" justifyContent="space-between" columnGap={2}>
                  <Text dimColor size="footnote" tabular>
                    第 {ev.step} 次请求 · {fmtClockTime(ev.at, tzMin)}
                  </Text>
                  <Text tabular size="footnote">
                    <Text dimColor>{fmtTokens(ev.from)} → </Text>
                    <Text color={ORANGE} weight="medium">
                      {fmtTokens(ev.to)}
                    </Text>
                    <Text dimColor>（-{pct(ev.from - ev.to, ev.from)}）</Text>
                  </Text>
                </Box>
              ))}
          </Box>
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
        <Section title="活动" note={`主会话 ${Object.values(d.tools).reduce((a, b) => a + b, 0)} 次工具调用（不含子 Agent）`}>
          <Text>
            {topEntries(groupTools(d.tools), 5)
              .map(([k, v]) => `${k} ${v}`)
              .join(' · ')}
          </Text>
          {allFileEntries.length > 0 ? (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={2}>
                <Text dimColor size="footnote">
                  文件活动
                </Text>
                <Box flexDirection="row" columnGap={1}>
                  {fileFilters.map(([fk, label]) => (
                    <Button
                      key={`dfile-filter-${fk}`}
                      label={label}
                      plain
                      dimColor={fileFilter !== fk}
                      onPress={() => setView(v => ({ ...v, fileFilter: fk, showAllFiles: false }))}
                    />
                  ))}
                </Box>
              </Box>
              {shownFiles.length === 0 ? (
                <Text dimColor size="footnote">
                  没有符合条件的文件。
                </Text>
              ) : (
                <Box flexDirection="column">
                  {shownFiles.map(([p, f]) => (
                    <Box key={`dfile-${p}`} flexDirection="row" justifyContent="space-between" columnGap={2}>
                      <Text wrap="truncate-start">{shortFilePath(p)}</Text>
                      <Text tabular dimColor>
                        {[f.r > 0 ? `读 ${f.r}` : '', f.w > 0 ? `写 ${f.w}` : ''].filter(Boolean).join(' · ')}
                      </Text>
                    </Box>
                  ))}
                </Box>
              )}
              {filteredFiles.length > FILES_VISIBLE ? (
                <Button
                  key="dfile-more"
                  label={
                    view.showAllFiles
                      ? filteredFiles.length > FILES_MAX
                        ? `收起（已显示前 ${FILES_MAX} 个，共 ${filteredFiles.length} 个）`
                        : '收起'
                      : filteredFiles.length > FILES_MAX
                        ? `显示前 ${FILES_MAX} 个（共 ${filteredFiles.length} 个）`
                        : `显示全部 ${filteredFiles.length} 个`
                  }
                  plain
                  dimColor
                  onPress={() => setView(v => ({ ...v, showAllFiles: !v.showAllFiles }))}
                />
              ) : null}
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
