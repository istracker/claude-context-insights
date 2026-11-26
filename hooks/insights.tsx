// 跨会话洞察：汇总 ~/.claude/projects 下所有会话的用量、成本与活动
import type { EngineInterface, RenderInput } from 'claude-code'

import type {
  AccountMap,
  DayAgg,
  InsightRange,
  Breakdown,
  InsightSort,
  InsightSettings,
  InsightTab,
  InsightView,
  RankKind,
  RateSnapshot,
  RateWindow,
  SessionAgg,
} from '../types'
import { dayKey, runScan } from './scan'
import {
  COMMAND,
  PANE,
  TITLE,
  getAccounts,
  getLimits,
  getScan,
  getSessions,
  getSettings,
  loadSettings,
  getView,
  LIMITS_STORE_KEY,
  readLiveLimits,
  setLimits,
  setSettings,
  setViewState,
} from './state'
import {
  ACCENT,
  AMBER,
  BLUE,
  ORANGE,
  PALETTE,
  TEAL,
  dailyTokenSvg,
  fluidBarSvg,
  fluidHeight,
  svgSize,
  thinStackSvg,
} from './charts'
import type { DayPoint } from './charts'
import {
  addCount,
  cacheReadFactor,
  cardStyle,
  fmtAgo,
  fmtTokens,
  fmtResetAt,
  quotaWindowName,
  fmtUsd,
  layoutTier,
  pct,
  prettyModel,
  sameAccountWindows,
  sessionAccount,
  sparkline,
  textBar,
  topEntries,
} from './util'

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
  /** 会话所在项目目录（终端恢复命令要先 cd 过去） */
  cwd?: string
  /** 当前上下文大小：最后一次请求的输入 + 缓存读 + 缓存写 */
  ctx?: number
  /** 用户最后一次提问（截断） */
  lastPrompt?: string
  /** 标题是不是用户自己起的（否则标题就是最后一次提问，不重复显示） */
  hasTitle: boolean
}

/**
 * 在 Claude Desktop 里打开会话：面板里的 Link 点了没有反应（内嵌页面不处理 claude:// 协议），
 * 所以交给系统的 open 去打开链接；失败（没有 open、被拒绝）就退回复制链接
 */
async function openInDesktop(
  $: EngineInterface,
  url: string,
  surface: PaneInput['surface'],
  isArchived = false,
): Promise<void> {
  const r = await $.process.run(['open', url], { timeoutMs: 5000 }).catch(() => undefined)
  if (r?.exitCode === 0) {
    $.ui.toast(isArchived ? '已发出打开请求。该会话已归档，若没打开，请先在 Desktop 里取消归档' : '已在 Desktop 打开', {
      timeoutMs: isArchived ? 6000 : 3000,
    })
    return
  }
  await $.ui.copy({ text: url, surface })
  $.ui.toast('打开失败，已复制链接，可粘贴到浏览器地址栏', { timeoutMs: 6000 })
}

/** 给 shell 用的单引号转义 */
export function shellQuote(v: string): string {
  return /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`
}

/** 上下文窗口：超过 200k 的必是 1M 窗口，其余按 200k 算 */
export function ctxWindowOf(ctx: number): number {
  return ctx > 200_000 ? 1_000_000 : 200_000
}

/** 会话搜索：标题、项目、最后一次提问里包含关键字（不分大小写） */
export function matchSession(s: { title: string; project: string; lastPrompt?: string }, query: string | undefined): boolean {
  const q = query?.trim().toLowerCase()
  if (!q) return true
  return [s.title, s.project, s.lastPrompt ?? ''].some(t => t.toLowerCase().includes(q))
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
      modelWeight: b.modelWeight ? { ...b.modelWeight } : {},
      tools: { ...b.tools },
      toolTokens: b.toolTokens ? { ...b.toolTokens } : {},
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
    modelWeight: mergeMap(a.modelWeight ?? {}, b.modelWeight ?? {}),
    tools: mergeMap(a.tools, b.tools),
    toolTokens: mergeMap(a.toolTokens ?? {}, b.toolTokens ?? {}),
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
      cwd,
      lastAt,
      costUsd: cost,
      isEstimated,
      days,
      dayUsd,
      ctx: main.isSub ? undefined : main.lastCtx,
      lastPrompt: main.lastPrompt,
      hasTitle: main.title !== undefined,
    })
  }
  return out
}

/** 上一个等长时间段，用于环比；「全部」没有 */
/** 按天偏移（0 = 今天）表示的闭区间 [近, 远]；全部时间为 undefined */
type DaySpan = [number, number]

/** 本地日历上的年、月（0 起）、日 */
function localDate(now: number, tzMin: number): { y: number; m: number; d: number } {
  const t = new Date(now + tzMin * 60_000)
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() }
}
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate()

/** 范围对应的天偏移区间 */
export function rangeSpan(range: InsightRange, now: number, tzMin: number): DaySpan | undefined {
  const { y, m, d } = localDate(now, tzMin)
  switch (range) {
    case 'today':
      return [0, 0]
    case 'yesterday':
      return [1, 1]
    case '7d':
      return [0, 6]
    case '30d':
      return [0, 29]
    case 'month':
      return [0, d - 1]
    case 'lastMonth':
      return [d, d + daysInMonth(y, m - 1) - 1]
    default:
      return undefined
  }
}

/** 环比用的上一段：本月对上月同期（1 号到同一天），上月对再上个月，其余向前平移同样天数 */
function prevSpan(range: InsightRange, now: number, tzMin: number): DaySpan | undefined {
  const span = rangeSpan(range, now, tzMin)
  if (!span) return undefined
  const { y, m, d } = localDate(now, tzMin)
  if (range === 'month') {
    const last = daysInMonth(y, m - 1)
    const n = Math.min(d, last)
    return [d + last - n, d + last - 1]
  }
  if (range === 'lastMonth') {
    const last = daysInMonth(y, m - 1)
    return [d + last, d + last + daysInMonth(y, m - 2) - 1]
  }
  const len = span[1] - span[0] + 1
  return [span[0] + len, span[1] + len]
}

function spanDays(span: DaySpan | undefined, now: number, tzMin: number): Set<string> | undefined {
  if (!span) return undefined
  const out = new Set<string>()
  for (let i = span[0]; i <= span[1]; i++) out.add(dayKey(now - i * DAY_MS, tzMin))
  return out
}
export function prevRangeDays(range: InsightRange, now: number, tzMin: number): Set<string> | undefined {
  return spanDays(prevSpan(range, now, tzMin), now, tzMin)
}
export function rangeDays(range: InsightRange, now: number, tzMin: number): Set<string> | undefined {
  return spanDays(rangeSpan(range, now, tzMin), now, tzMin)
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
  toolTokens: Record<string, number>
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
    toolTokens: {},
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
    mergeMapInPlace(t.toolTokens, d.toolTokens ?? {})
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

/** 排行的一项：主排序值（成本 / 估算 token / 次数）、副计数（请求数 / 调用次数）、最近日期（YYYY-MM-DD）、用过它的会话 */
export type RankItem = { value: number; subCount: number; tokens: number; lastDay: string; ids: Set<string> }

/**
 * 把会话在这段时间里的模型（按成本）、工具（按上下文估算 token）汇总成决策排行。
 */
export function rankIndex(
  sessions: MergedSession[],
  days: Set<string> | undefined,
  expandMcp: boolean,
): Record<RankKind, Map<string, RankItem>> {
  const out: Record<RankKind, Map<string, RankItem>> = {
    model: new Map(),
    tool: new Map(),
  }
  const add = (kind: RankKind, key: string, value: number, subCount: number, tokens: number, day: string, id: string) => {
    const it = out[kind].get(key) ?? { value: 0, subCount: 0, tokens: 0, lastDay: '', ids: new Set<string>() }
    it.value += value
    it.subCount += subCount
    it.tokens += tokens
    if (day > it.lastDay) it.lastDay = day
    it.ids.add(id)
    out[kind].set(key, it)
  }
  for (const s of sessions) {
    for (const [k, d] of Object.entries(s.days)) {
      if (days && !days.has(k)) continue
      const usd = s.dayUsd[k] ?? 0
      // 1. 模型按成本排行：按当天各模型的计费权重（无权重时退回请求数占比）分摊当天成本
      const mwMap = d.modelWeight ?? {}
      const sumMw = Object.values(mwMap).reduce((a, b) => a + b, 0)
      const sumReq = Object.values(d.models).reduce((a, b) => a + b, 0)
      for (const [m, reqs] of Object.entries(d.models)) {
        if (reqs <= 0) continue
        const mw = mwMap[m] ?? 0
        const share = sumMw > 0 ? mw / sumMw : sumReq > 0 ? reqs / sumReq : 0
        const mUsd = usd * share
        // 若整个会话未估价（usd=0），退回用请求数作为微弱正值，保证已用模型仍可见
        // token 没有按模型记录，按同一份份额从当天 token 里分摊
        add('model', m, mUsd > 0 ? mUsd : reqs * 1e-9, reqs, tokensOf(d) * share, k, s.id)
      }

      // 2. 工具按往上下文塞入的估算 token 排行（副计数保留调用次数）
      const tokMap = d.toolTokens ?? {}
      for (const [name, calls] of Object.entries(d.tools)) {
        if (calls <= 0) continue
        const tok = tokMap[name] ?? calls
        add('tool', toolKey(name, expandMcp), tok, calls, tok, k, s.id)
      }
    }
  }
  return out
}

/** 按项目分组后的一组会话 */
export type ProjectGroup<T> = { name: string; sessions: T[]; usd: number; tokens: number; lastAt: number; ctxShare: number }

/**
 * 把（已排好序、已过滤的）会话按项目分组。组内保持传入顺序；
 * 组的顺序跟随排序方式：按 token 看项目总 token，按当前上下文看组内最高占比，按时间看最近活动（旧的「按成本」仍按总成本）。
 */
export function groupByProject<
  T extends { project: string; lastAt: number; r: { usd: number; in: number; out: number; cr: number; cw: number }; ctx?: number },
>(
  sessions: T[],
  sort: InsightSort,
): ProjectGroup<T>[] {
  const map = new Map<string, ProjectGroup<T>>()
  for (const s of sessions) {
    const g = map.get(s.project) ?? { name: s.project, sessions: [], usd: 0, tokens: 0, lastAt: 0, ctxShare: -1 }
    g.sessions.push(s)
    g.usd += s.r.usd
    g.tokens += tokensOf(s.r)
    g.lastAt = Math.max(g.lastAt, s.lastAt)
    if (s.ctx !== undefined) g.ctxShare = Math.max(g.ctxShare, s.ctx / ctxWindowOf(s.ctx))
    map.set(s.project, g)
  }
  return [...map.values()].sort((a, b) =>
    sort === 'tokens'
      ? b.tokens - a.tokens || b.lastAt - a.lastAt
      : sort === 'cost'
        ? b.usd - a.usd || b.lastAt - a.lastAt
        : sort === 'context'
        ? b.ctxShare - a.ctxShare || b.lastAt - a.lastAt
        : b.lastAt - a.lastAt,
  )
}

/** 账号显示名：邮箱，没见过就用 id 前 4 位 */
export function accountLabel(acc: AccountMap, id: string | undefined): string {
  if (id === undefined) return '未归属'
  const l = acc.labels[id]
  const base = l?.alias ?? l?.email ?? l?.name ?? `账号 ${id.slice(0, 4)}`
  return id === acc.current ? `${base}（当前）` : base
}

// ---------- 文案 ----------

/** 卡片右上角的时间范围说明 */
const RANGE_TITLE: Record<InsightRange, string> = {
  today: '今天',
  yesterday: '昨天',
  '7d': '近 7 天',
  '30d': '近 30 天',
  month: '本月',
  lastMonth: '上月',
  all: '全部时间',
}
/** 下拉里的顺序 */
const RANGE_MENU: InsightRange[] = ['today', 'yesterday', '7d', '30d', 'month', 'lastMonth', 'all']
const PREV_TITLE: Record<InsightRange, string> = {
  today: '昨天',
  yesterday: '前天',
  '7d': '前 7 天',
  '30d': '前 30 天',
  month: '上月同期',
  lastMonth: '前一个月',
  all: '',
}
const SORTS: [InsightSort, string][] = [
  ['recent', '按时间'],
  ['tokens', '按 token'],
]
const ACCOUNT_COLORS = PALETTE
/** 排行点选的对象在会话筛选提示里怎么称呼 */
const RANK_NOUN: Record<RankKind, string> = { model: '模型', tool: '工具' }
/** 设置页最多列出多少个项目（最近活跃的在前，已排除的总会列出） */
const SETTINGS_PROJECTS = 12

// ---------- 注册 ----------

/** 会话开始时调用：注册命令并做一次增量扫描（只读上次之后新增的日志） */
export async function startInsights($: EngineInterface): Promise<void> {
  await $.command.register({
    name: COMMAND,
    description: '打开上下文洞察：额度、用量与会话（full 精确统计本会话，close 关闭面板）',
  })
  // 各账号上次的额度读数存在 $.store（跨会话），载入到本会话状态
  const stored = (await $.store.get(LIMITS_STORE_KEY)) as Record<string, RateSnapshot> | undefined
  // 与 refresh 并发：已有的（更新的）读数优先，旧读数只补缺
  if (stored && typeof stored === 'object') await setLimits($, cur => ({ ...stored, ...cur }))
  // 插件设置跨会话保存在 $.store
  await loadSettings($)
  void runScan($)
}

// /ctx 的处理在 register.tsx（要调用本会话的精确统计）

/** 「洞察」标签页的内容：所有会话的额度、成本、会话与活动 */
/**
 * 上一次绘制的结果与它的输入签名。面板每滚动一下宿主都会带着新的滚动位置重新调用绘制，
 * 而滚动不改变任何要画的内容：签名不变时直接返回上次的树，不再重算 55 个会话的合并、分组与排序
 * （之前每次滚动都整页重算，展开的项目越多越慢，滚动就越抖）。
 */
let insightsMemo: { sig: string; tree: JSX.Element } | undefined

export async function renderInsights($: EngineInterface, e: PaneInput): Promise<JSX.Element> {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Select, Input } = els
    // 终端的元素表里也有 Svg，但画不出来：按绘制端判断，终端用文字兜底
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const card = cardStyle(e.surface)
    // 显式给宽高（不给高度时桌面端内嵌框默认 150px）。宽度也要给：不给时宿主会把图放大到铺满面板，
    // 而框高仍按原图算，宽面板下底部（坐标轴、日期）就被裁掉。高度多留 4%，防宽度略估大时被等比缩放后裁底；viewHeight 小于内容高度时，模块内部可上下滑动
    const Chart = (p: { source: string; alt: string; isInteractive?: boolean; viewHeight?: number }) => {
      if (!Svg) return null
      // 注意：JSX 编译成全局 h(...)，局部变量不能叫 h
      // 铺满图：不给宽度（宿主按标记里的 100% 铺满卡片），高度照原样
      const fluidH = fluidHeight(p.source)
      const size = svgSize(p.source)
      return (
        <Svg
          source={p.source}
          alt={p.alt}
          width={fluidH === undefined ? size.width : undefined}
          height={fluidH ?? p.viewHeight ?? Math.ceil(size.height * 1.04) + 2}
          // 只有需要悬停提示的图才放进沙盒内嵌框；其余画成普通图片。
          // 内嵌框会抢滚轮事件、各自重排，列表里一多（会话圆环、额度条）滚动就会严重抖动
          isInteractive={p.isInteractive === true ? true : undefined}
        />
      )
    }
    const aggs = await getSessions($)
    const scan = await getScan($)
    const view = await getView($)
    const settings: InsightSettings = await getSettings($)
    const showMoney = settings.showMoney !== false
    const storedAccounts = await getAccounts($)
    const currentSessionId = await $.session.id().catch(() => undefined)
    // 「当前」以本会话的归属为准（状态里的 current 可能是重新加载插件前算的）
    // 设置里的显示名覆盖邮箱
    const labels = { ...storedAccounts.labels }
    for (const [id, name] of Object.entries(settings.aliases ?? {})) {
      if (name.trim()) labels[id] = { ...labels[id], alias: name.trim() }
    }
    const accounts: AccountMap = {
      ...storedAccounts,
      labels,
      current: sessionAccount(storedAccounts, currentSessionId),
    }
    const now = await $.clock.now()
    // 绘制签名：只含会改变画面的输入（数据、视图设置、面板宽度、额度读数、时间按 30 秒取整），不含滚动位置
    const sigParts = [
      e.surface,
      e.props.bodyColumns,
      e.props.placement,
      view,
      settings,
      scan,
      aggs.length,
      aggs.reduce((a, x) => a + x.offset + (x.lastAt ?? 0), 0),
      storedAccounts,
      currentSessionId,
      await getLimits($),
      await readLiveLimits($, now),
      Math.floor(now / 30_000),
    ].map(x => JSON.stringify(x) ?? '')
    const sig = sigParts.join('|')
    if (insightsMemo?.sig === sig) return insightsMemo.tree
    const tzMin = scan.tzMin ?? -new Date().getTimezoneOffset()
    const setView = (fn: (v: InsightView) => InsightView) => void setViewState($, fn)

    // ----- 数据 -----
    // 标题优先用 Desktop 侧边栏里的标题，找会话时和侧边栏对得上；搜索也按它匹配
    const everything = mergeSessions(aggs).map(s => {
      const dm = accounts.desktopMeta?.[s.id]
      return { ...s, account: accounts.bySession[s.id], title: dm?.title ?? s.title, hasTitle: s.hasTitle || dm?.title !== undefined }
    })
    const excluded = new Set(settings.excluded ?? [])
    const all = excluded.size > 0 ? everything.filter(s => !excluded.has(s.project)) : everything
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
    /** 会话列表不受时间范围影响：列出全部有活动的会话，token 是会话累计总量 */
    const listed: (MergedSession & { r: Totals })[] = []
    for (const s of scoped) {
      const r = addSession(emptyTotals(), s, undefined)
      if (r.req === 0 && r.prompts === 0) continue
      listed.push({ ...s, r })
    }

    const prevDays = prevRangeDays(view.range, now, tzMin)
    let prevTokens: number | undefined
    if (prevDays) {
      const prev = emptyTotals()
      for (const s of scoped) addSession(prev, s, prevDays)
      prevTokens = tokensOf(prev)
    }
    const tokenDelta =
      prevTokens !== undefined && prevTokens > 100_000 ? (tokensOf(total) - prevTokens) / prevTokens : undefined

    const byAccount = new Map<string, { tokens: number; usd: number }>()
    if (view.account === undefined) {
      for (const s of all) {
        let usd = 0
        let tokens = 0
        for (const [k, d] of Object.entries(s.days)) {
          if (days && !days.has(k)) continue
          usd += s.dayUsd[k] ?? 0
          tokens += tokensOf(d)
        }
        if (tokens <= 0) continue
        const k = s.account ?? 'none'
        const cur = byAccount.get(k) ?? { tokens: 0, usd: 0 }
        byAccount.set(k, { tokens: cur.tokens + tokens, usd: cur.usd + usd })
      }
    }

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

    // 每日柱图的天数：覆盖所选范围；单日范围画到那天为止的 7 天，全部时间画最近 30 天
    const span = rangeSpan(view.range, now, tzMin) ?? [0, 29]
    const seriesFrom = span[0]
    const seriesTo = Math.max(span[1], span[0] + 6)
    const seriesDays = seriesTo - seriesFrom + 1
    const series: DayPoint[] = []
    for (let i = seriesTo; i >= seriesFrom; i--) {
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

    // 决策排行：模型（按成本）、工具（按上下文估算 token）
    // 点模型筛选会话：按全部时间算用过它的会话（会话列表本身不分时段）
    const ranks = rankIndex(active, days, view.expandMcp ?? false)
    const allRanks = rankIndex(listed, undefined, false)
    // 旧状态里可能残留已移除的排行（如 prog、proj、skill），只认当前存在的排行
    const activePick =
      view.pick && view.pick.kind in ranks ? view.pick : undefined
    const pickLabel = activePick ? (activePick.kind === 'model' ? prettyModel(activePick.key) : activePick.key) : ''
    const pickedIds = activePick ? (allRanks[activePick.kind]?.get(activePick.key)?.ids ?? new Set<string>()) : undefined
    // 只剩「按时间」「按 token」：旧状态里的 cost 按 token 排，context 退回按时间
    const sortMode: InsightSort = view.sort === 'cost' ? 'tokens' : view.sort === 'context' ? 'recent' : view.sort
    const sorted = [...listed]
      .filter(
        s =>
          (pickedIds === undefined || pickedIds.has(s.id)) &&
          matchSession(s, view.query),
      )
      .sort((a, b) =>
        sortMode === 'tokens' ? tokensOf(b.r) - tokensOf(a.r) : b.lastAt - a.lastAt,
      )
    // 会话以项目为主线：项目一行，展开后列出它的会话
    const groups = groupByProject(sorted, sortMode)
    const isFiltering = activePick !== undefined || Boolean(view.query?.trim())
    // 只区分主页与设置页；旧状态里的 sessions / tools 页签都按主页处理
    const tab: InsightTab = view.tab === 'settings' ? 'settings' : 'overview'
    // 「会话」模块高度固定（minHeight，见 sessionBodyRows），展开/收起项目、翻页都不改变模块高度：
    // 项目分页；一次只展开一个项目，展开时其他项目整个隐藏（不占高度），展开的项目里会话再分页；
    // 分页器固定在模块底部。每页项目数按模块高度算，让项目列表刚好填满
    const tier = layoutTier(e.props.bodyColumns)
    const isNarrow = tier === 'narrow'
    /** 展开的项目每页 6 个会话（一屏放得下，不用滚动）；模块高度按「满 6 个 + 分页器」固定 */
    const SESSIONS_PER_PAGE = 6
    // 高度估算（单位：字符行，minHeight 的单位）。桌面端的文字行、间距、内边距都比一个字符行小，
    // 按实测折算；终端按字符行整数算
    const U =
      e.surface === 'terminal'
        ? { line: 1, gap: 1, pad: 1, cardExtra: 2, listRow: 2, pager: 1 }
        : { line: 0.9, gap: 0.5, pad: 0.5, cardExtra: 0.75, listRow: 1.5, pager: 0.9 }
    /** 一个会话卡片：两行文字加边框与内边距 */
    const rowH = 2 * U.line + U.cardExtra
    /** 展开一个有 n 个会话的项目所需的行数：项目头 + 间距 + 内边距 + 卡片们 +（多页时）底部分页器 */
    const openRows = (n: number) => {
      const k = Math.min(SESSIONS_PER_PAGE, Math.max(1, n))
      return U.line + U.gap + U.pad + k * rowH + (k - 1) * U.gap + (n > SESSIONS_PER_PAGE ? U.gap + U.pager : 0)
    }
    // 不看实际会话数：始终按一整页（6 个会话 + 分页器）的高度留位，换项目、翻页、筛选时高度都不变
    const expandedMax = openRows(SESSIONS_PER_PAGE + 1)
    const PROJECTS_PER_PAGE = Math.max(5, Math.min(14, Math.floor((expandedMax - U.gap - U.pager) / U.listRow)))
    const projectPages = Math.max(1, Math.ceil(groups.length / PROJECTS_PER_PAGE))
    const projectPage = Math.min(Math.max(0, view.page ?? 0), projectPages - 1)
    const shownGroups = groups.slice(projectPage * PROJECTS_PER_PAGE, (projectPage + 1) * PROJECTS_PER_PAGE)
    /**
     * 展开哪个项目（一次只有一个）：
     * - 用户点开的那个；用户收起后（空字符串）一个都不展开，显示项目列表
     * - 没选过（或选的不在本页）：搜索或筛选时，只有一个项目有结果就直接展开它（结果多个项目时显示项目列表，各带命中数）；
     *   平时展开「当前会话所在的项目」，当前会话不在本页就展开本页第一个
     */
    const wanted = view.openProjects?.[0]
    const currentGroup = shownGroups.find(g => g.sessions.some(x => x.id === currentSessionId))?.name
    const defaultOpen = isFiltering ? (groups.length === 1 ? groups[0]?.name : undefined) : (currentGroup ?? shownGroups[0]?.name)
    const openProject =
      wanted === '' ? undefined : wanted !== undefined && shownGroups.some(g => g.name === wanted) ? wanted : defaultOpen
    const isProjectOpen = (name: string) => name === openProject
    /** 展开时隐藏其他项目：不占高度 */
    const visibleGroups = openProject !== undefined ? shownGroups.filter(g => g.name === openProject) : shownGroups
    // 宽屏下把「钱花在哪」与「每日成本」并排，压缩纵向滚动长度
    const showAccounts = view.account === undefined && byAccount.size > 1
    /**
     * 「会话」模块的固定高度（行）：项目列表与任一项目展开后的行数取大，两种状态都按它撑满，
     * 展开、收起、翻页都不改变模块高度。用 minHeight 而不是 height，估少了也只是略高、不会裁掉内容
     */
    const listRows = shownGroups.length * U.listRow + (projectPages > 1 ? U.gap + U.pager : 0)
    const sessionBodyRows = Math.ceil(Math.max(listRows, expandedMax))
    const openGroup = openProject !== undefined ? visibleGroups[0] : undefined
    const openPages = openGroup ? Math.max(1, Math.ceil(openGroup.sessions.length / SESSIONS_PER_PAGE)) : 1
    const openPage = Math.min(Math.max(0, view.sessionPage ?? 0), openPages - 1)

    // ----- 小组件 -----
    /** 区块卡片：标题 · 旁注 ··· 右上角关键数字 · 操作 */
    const Section = (props: {
      title: string
      note?: string
      stat?: string
      right?: JSX.Element | null
      children?: unknown
    }) => (
      <Box flexDirection="column" gap={2} {...card}>
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
                <Text tabular dimColor size="footnote">
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
    /** 一个额度窗口：上行「窗口名 ··· 重置时刻 已用%」，下行进度条（与 Claude 自带用量界面同风格）；桌面端整行画成一张图，百分比对齐进度条右端 */
    const quotaRow = (key: string, w: RateWindow, isStale: boolean) => {
      const resetAt = w.resetsAt ? Date.parse(w.resetsAt) : NaN
      const isReset = !Number.isNaN(resetAt) && resetAt <= now
      const p = Math.max(0, Math.min(100, w.percentUsed))
      // 80% 起变黄、95% 起变橙，与会话上下文的配色规则一致
      const color = p >= 95 ? ORANGE : p >= 80 ? AMBER : ACCENT
      const name = quotaWindowName(w.kind)
      const reset = Number.isNaN(resetAt) ? '' : isReset ? '已重置' : `${fmtResetAt(resetAt, now, tzMin)} 重置`
      const percent = isReset ? '—' : `已用 ${w.percentUsed}%`
      if (Svg) {
        // 文字用文字元素（两端对齐），进度条横向铺满所在列：不再按估算的像素宽度画，列多宽条就多宽
        return (
          <Box key={key} flexDirection="column" gap={1}>
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
              <Text weight="medium" wrap="truncate-end">
                {name}
              </Text>
              <Text tabular>
                <Text dimColor>{reset}  </Text>
                <Text weight="medium" dimColor={isReset}>
                  {percent}
                </Text>
              </Text>
            </Box>
            <Chart source={fluidBarSvg(isReset ? 0 : p / 100, color, isStale)} alt={`${name} ${reset} ${percent}`} />
          </Box>
        )
      }
      return (
        <Box key={key} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
            <Text wrap="truncate-end">{name}</Text>
            <Text tabular>
              <Text dimColor>{reset} </Text>
              <Text color={!isReset && p >= 80 ? color : undefined} dimColor={isReset}>
                {percent}
              </Text>
            </Text>
          </Box>
          <Text color={color}>{textBar(isReset ? 0 : p, 20)}</Text>
        </Box>
      )
    }
    const pctDone = scan.totalBytes > 0 ? Math.round((scan.doneBytes / scan.totalBytes) * 100) : 100

    const accountOptions = [
      { value: 'all', label: '全部账号' },
      ...accountIds.map(id => ({ value: id, label: accountLabel(accounts, id) })),
      ...(hasUnassigned ? [{ value: 'none', label: '未归属' }] : []),
    ]

    /** 构成表的一行：色块 · 名称（可点）· token · token 占比 · ≈ 金额（金额为辅，可在设置里关掉） */
    type ShareRow = {
      key: string
      name: string
      tokens: number
      usd: number
      color: string
      isPicked: boolean
      onPress?: () => void
    }
    /** 构成表：上面一根细分段条，下面固定行数的明细，切换维度时高度不变 */
    const breakdownTable = (id: string, rows: ShareRow[], slots: number) => {
      const sum = rows.reduce((a, r) => a + r.tokens, 0)
      const pad = Math.max(0, slots - rows.length)
      return (
        <Box key={`share-${id}`} flexDirection="column" gap={1}>
          {Svg ? (
            <Chart source={thinStackSvg(rows.map(r => ({ value: r.tokens, color: r.color })))} alt="token 构成" />
          ) : null}
          <Box flexDirection="column">
            {rows.map(r => {
              const label = (
                <Text wrap="truncate-end" weight={r.isPicked ? 'semibold' : 'regular'} color={r.isPicked ? ACCENT : undefined}>
                  {r.isPicked ? `✓ ${r.name}` : r.name}
                </Text>
              )
              return (
                <Box key={`share-${id}-${r.key}`} flexDirection="row" alignItems="center" columnGap={2}>
                  <Text color={r.color}>■</Text>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    {r.onPress ? (
                      <Button key={`share-btn-${id}-${r.key}`} plain onPress={r.onPress}>
                        {label}
                      </Button>
                    ) : (
                      label
                    )}
                  </Box>
                  <Box minWidth={8} justifyContent="flex-end">
                    <Text tabular>{fmtTokens(r.tokens)}</Text>
                  </Box>
                  <Box minWidth={6} justifyContent="flex-end">
                    <Text tabular dimColor>
                      {pct(r.tokens, sum)}
                    </Text>
                  </Box>
                  {showMoney ? (
                    <Box minWidth={isNarrow ? 8 : 10} justifyContent="flex-end">
                      <Text tabular dimColor>
                        ≈ {fmtUsd(r.usd)}
                      </Text>
                    </Box>
                  ) : null}
                </Box>
              )
            })}
            {Array.from({ length: pad }, (_, i) => (
              <Text key={`share-${id}-pad-${i}`}> </Text>
            ))}
          </Box>
        </Box>
      )
    }
    const modelRows: ShareRow[] = [...ranks.model.entries()]
      .filter(([, it]) => it.tokens > 0)
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([k, it], i) => {
        const isPicked = activePick?.kind === 'model' && activePick.key === k
        return {
          key: k,
          name: prettyModel(k),
          tokens: it.tokens,
          usd: it.value,
          color: PALETTE[i % PALETTE.length] ?? BLUE,
          isPicked,
          onPress: () =>
            setView(v => ({
              ...v,
              pick: isPicked ? undefined : { kind: 'model', key: k },
              page: 0,
              sessionPage: 0,
            })),
        }
      })
    /** 账号的固定颜色：按账号在下拉框里的顺序取，会话行的小圆点与「按账号」图例同色 */
    const acctColor = (id: string): string => ACCOUNT_COLORS[Math.max(0, accountIds.indexOf(id)) % ACCOUNT_COLORS.length] ?? BLUE
    const accountRows: ShareRow[] = [...byAccount.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([k, v], i) => ({
        key: k,
        // 只留 @ 前面的部分，和会话行写法一致
        name: k === 'none' ? '未归属' : accountLabel(accounts, k).replace(/@[^（]*/, ''),
        tokens: v.tokens,
        usd: v.usd,
        color: k === 'none' ? (ACCOUNT_COLORS[i % ACCOUNT_COLORS.length] ?? BLUE) : acctColor(k),
        isPicked: false,
        onPress: () => setView(vw => ({ ...vw, account: k, page: 0 })),
      }))

    // 构成：类型 / 模型 / 账号三选一，一次只看一张表；都按 token 排
    const typeRows: ShareRow[] = [...PARTS]
      .sort((a, b) => total[b.key] - total[a.key])
      .map((p, i) => ({
        key: p.key,
        name: p.name,
        tokens: total[p.key],
        usd: total.usdBy[p.key],
        color: PALETTE[i] ?? p.color,
        isPicked: false,
      }))
    const breakdownTabs: [Breakdown, string][] = [
      ['type', '按类型'],
      ...(modelRows.length > 0 ? ([['model', '按模型']] as [Breakdown, string][]) : []),
      ...(showAccounts ? ([['account', '按账号']] as [Breakdown, string][]) : []),
    ]
    /** 构成表固定行数：取各维度里最多的那个（最多 BREAKDOWN_MAX 行），切换时高度不变 */
    const BREAKDOWN_MAX = 6
    const breakdownSlots = Math.min(
      BREAKDOWN_MAX,
      Math.max(typeRows.length, modelRows.length, showAccounts ? accountRows.length : 0),
    )
    const breakdown: Breakdown = breakdownTabs.some(([k]) => k === view.breakdown) ? (view.breakdown ?? 'type') : 'type'
    const tokenTotal = tokensOf(total)
    const tokenChange =
      tokenDelta === undefined
        ? undefined
        : Math.abs(tokenDelta) < 0.005
          ? `持平 比${PREV_TITLE[view.range]}`
          : `${tokenDelta > 0 ? '↑' : '↓'} ${Math.abs(tokenDelta * 100).toFixed(0)}% 比${PREV_TITLE[view.range]}`
    /** 主数字下的一排小指标：金额排第一格但字号与其余相同，只作参考 */
    const usageStats: [string, string][] = [
      ...(showMoney ? ([['等价 API 成本', `≈ ${fmtUsd(total.usd)}`]] as [string, string][]) : []),
      ['会话', active.length.toLocaleString()],
      ['提问', total.prompts.toLocaleString()],
      ['缓存命中', pct(total.cr, prompted)],
    ]
    const avgTokens = series.length > 0 ? series.reduce((a, x) => a + x.tokens, 0) / series.length : 0
    /** 柱图下的首、中、尾三个日期 */
    const axisLabel = (i: number) => (series[i]?.day ?? '').slice(5).replace('-', '/')
    const axisDays = series.length > 2 ? [axisLabel(0), axisLabel(Math.floor((series.length - 1) / 2)), axisLabel(series.length - 1)] : series.map((_, i) => axisLabel(i))

    /** 时间范围下拉：只写名称；具体日期写在用量卡的副标题里 */
    const rangeOptions = RANGE_MENU.map(r => ({ value: r, label: RANGE_TITLE[r] }))
    const curSpan = rangeSpan(view.range, now, tzMin)
    const md = (k: string) => k.slice(5).replace('-', '/')
    const rangeDates = curSpan
      ? curSpan[0] === curSpan[1]
        ? md(dayKey(now - curSpan[0] * DAY_MS, tzMin))
        : `${md(dayKey(now - curSpan[1] * DAY_MS, tzMin))} – ${md(dayKey(now - curSpan[0] * DAY_MS, tzMin))}`
      : '全部记录'
    /** 用量：token 为主（本地记录，准确），金额为辅（按标价折算，估算） */
    const spendCard = (
      <Section
        title="用量"
        right={
          // 时间范围只影响这张卡：放在卡片右上角
          <Select
            key="range"
            options={rangeOptions}
            value={view.range}
            onSelect={value => setView(v => ({ ...v, range: value as InsightRange }))}
          />
        }
      >
        {/* 1. 主数字：token 总量与环比 */}
        <Box flexDirection="column" gap={2}>
          <Box flexDirection="row" flexWrap="wrap" alignItems="flex-end" columnGap={1}>
            <Text weight="medium" size="title" tabular>
              {fmtTokens(tokenTotal)}
            </Text>
            <Text dimColor>token</Text>
            <Text dimColor size="footnote" tabular>
              {'  '}
              {rangeDates}
              {tokenChange ? ` · ${tokenChange}` : ''}
            </Text>
          </Box>
          {/* 2. 一排小指标：标签在上、数值在下 */}
          <Box flexDirection="row" columnGap={2}>
            {usageStats.map(([label, value]) => (
              <Box key={`stat-${label}`} flexDirection="column" flexGrow={1} width="25%" minWidth={0}>
                <Text dimColor size="footnote" wrap="truncate-end">
                  {label}
                </Text>
                <Text tabular wrap="truncate-end">
                  {value}
                </Text>
              </Box>
            ))}
          </Box>
          {scan.isRunning ? (
            <Text dimColor size="footnote">
              正在读取会话日志 {scan.doneFiles}/{scan.totalFiles}，数字会随扫描增加
            </Text>
          ) : null}
        </Box>

        {/* 3. 每天的 token：折线 + 日均虚线 */}
        <Box flexDirection="column">
          {Svg ? (
            <Chart source={dailyTokenSvg(series, 100, showMoney, seriesFrom === 0)} alt={`${RANGE_TITLE[view.range]}每日 token（${seriesDays} 天）`} isInteractive />
          ) : (
            <Text color={ACCENT}>
              {sparkline(
                series.map(x => x.tokens),
                Math.max(...series.map(x => x.tokens)),
              )}
            </Text>
          )}
          {/* 日期标注画在图外：图横向拉伸铺满，图里的文字会被拉变形 */}
          {Svg && series.length > 0 ? (
            <Box flexDirection="row" justifyContent="space-between">
              {axisDays.map((d, i) => (
                <Text key={`axis-${i}`} dimColor size="footnote" tabular>
                  {d}
                </Text>
              ))}
            </Box>
          ) : null}
          <Text dimColor size="footnote" tabular>
            ┄ 日均 {fmtTokens(avgTokens)}
            {seriesFrom === 0 ? `    今天 ${fmtTokens(series[series.length - 1]?.tokens ?? 0)}（进行中）` : ''}
          </Text>
        </Box>

        {/* 4. 构成：类型 / 模型 / 账号切换 */}
        {tokenTotal > 0 ? (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" columnGap={1}>
              {breakdownTabs.map(([k, label]) => (
                <Button
                  key={`breakdown-${k}`}
                  label={label}
                  plain
                  dimColor={breakdown !== k}
                  onPress={() => setView(v => ({ ...v, breakdown: k }))}
                />
              ))}
            </Box>
            {breakdownTable(
              breakdown,
              (breakdown === 'model' ? modelRows : breakdown === 'account' ? accountRows : typeRows).slice(0, BREAKDOWN_MAX),
              breakdownSlots,
            )}
          </Box>
        ) : null}
        <Text dimColor size="footnote">
          token 来自本地会话记录{showMoney ? '；金额按 API 标价折算，仅供参考，不是账单' : ''}
          {showMoney && unpriced > 0 ? `（${unpriced} 个会话无法估价）` : ''}。点模型或账号可筛选会话。
        </Text>
      </Section>
    )

    // ----- 设置页 -----
    const settingsPage = tab === 'settings' ? await renderSettings() : null
    async function renderSettings(): Promise<JSX.Element> {
      const claudeDir = (await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)) || '~/.claude'
      const saveSettings = (fn: (v: InsightSettings) => InsightSettings) => void setSettings($, fn)
      const countBy = new Map<string, number>()
      for (const s of everything) countBy.set(s.account ?? 'none', (countBy.get(s.account ?? 'none') ?? 0) + 1)
      // 项目：最近活跃的在前，已排除的总会列出
      const projectLast = new Map<string, number>()
      for (const s of everything) projectLast.set(s.project, Math.max(projectLast.get(s.project) ?? 0, s.lastAt))
      const projects = [...projectLast.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
      const shownProjects = [
        ...projects.slice(0, SETTINGS_PROJECTS),
        ...projects.slice(SETTINGS_PROJECTS).filter(p => excluded.has(p)),
      ]
      const group = (title: string) => (
        <Box key={`set-h-${title}`} paddingTop={1}>
          <Text dimColor size="footnote">
            {title}
          </Text>
        </Box>
      )
      const row = (key: string, name: string, note: string | undefined, right?: JSX.Element | null) => (
        <Box key={`set-${key}`} flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={3}>
          <Box flexDirection="column" flexShrink={1} minWidth={0}>
            <Text wrap="truncate-end">{name}</Text>
            {note ? (
              <Text dimColor size="footnote" wrap="truncate-end">
                {note}
              </Text>
            ) : null}
          </Box>
          {right ?? null}
        </Box>
      )
      const toggle = (key: string, on: boolean, onPress: () => void, onLabel = '开', offLabel = '关') => (
        <Button key={`set-tg-${key}`} label={on ? onLabel : offLabel} variant={on ? 'primary' : 'secondary'} onPress={onPress} />
      )
      return (
        <Section title="插件设置" stat="修改即时生效">
          {group('数据来源')}
          {row('logs', '会话日志', `${claudeDir}/projects · 自动检测 · ${everything.length} 个会话`)}
          {row('index', '账号索引', `Claude Desktop 的 claude-code-sessions · 只读，用于标注会话所属账号 · 已识别 ${accountIds.length} 个账号`)}

          {group('账号显示名')}
          {accountIds.map(id => {
            const l = storedAccounts.labels[id]
            const email = l?.email ?? l?.name ?? `账号 ${id.slice(0, 4)}`
            return row(
              `acct-${id}`,
              email,
              `${id === accounts.current ? '当前账号 · ' : ''}${countBy.get(id) ?? 0} 个会话`,
              <Input
                key={`alias-${id}`}
                placeholder="显示名"
                value={settings.aliases?.[id] ?? ''}
                submitLabel="保存"
                onSubmit={value => saveSettings(v => ({ ...v, aliases: { ...v.aliases, [id]: value.trim() } }))}
              />,
            )
          })}
          {countBy.get('none')
            ? row('acct-none', '未归属', `${countBy.get('none')} 个会话 · 在终端直接运行的 CLI 会话不在 Desktop 索引里`)
            : null}

          {group('排除项目')}
          {shownProjects.map(p =>
            row(
              `proj-${p}`,
              p,
              undefined,
              toggle(
                `proj-${p}`,
                excluded.has(p),
                () =>
                  saveSettings(v => {
                    const set = new Set(v.excluded ?? [])
                    if (set.has(p)) set.delete(p)
                    else set.add(p)
                    return { ...v, excluded: [...set] }
                  }),
                '已排除',
                '统计中',
              ),
            ),
          )}
          {projects.length > shownProjects.length ? (
            <Text dimColor size="footnote">
              只列出最近活跃的 {SETTINGS_PROJECTS} 个项目
            </Text>
          ) : null}

          {group('显示')}
          {row(
            'auto-open',
            '新会话自动打开',
            '开启后每次新开会话自动弹出面板',
            toggle('auto-open', settings.autoOpen === true, () =>
              saveSettings(v => ({ ...v, autoOpen: !(v.autoOpen === true) })),
            ),
          )}
          {row(
            'money',
            '显示金额',
            '关闭后隐藏所有「≈ $」等价成本',
            toggle('money', showMoney, () => saveSettings(v => ({ ...v, showMoney: !(v.showMoney !== false) }))),
          )}

          {group('维护')}
          {row(
            'rescan',
            '重新扫描',
            scan.isRunning ? `扫描中 ${pctDone}%` : `已读取 ${scan.totalFiles} 个日志文件`,
            <Button key="rescan" label="重新扫描" variant="secondary" onPress={() => void runScan($)} />,
          )}

          {group('关于数据')}
          <Text dimColor size="footnote">
            token 来自本机会话记录（jsonl），按每条消息的 usage 字段累计，是准确值。金额按各模型 API 标价折算，订阅用户不按它计费，仅供参考。会话所属账号来自
            Claude Desktop 的会话索引，不在索引里的记为「未归属」。订阅额度读取自 Claude 客户端，非当前账号显示最后一次读数。所有数据只在本机计算，不上传。
          </Text>
        </Section>
      )
    }

    // 按下后焦点环会停在这个按钮上，宿主又会「保持焦点可见」：往下滚走后被拉回，就是抖动。
    // 所以每次按下都给按钮换个 key（fk），原来的元素消失，焦点环不再钉在滚出视野的按钮上
    const fk = (k: string) => `${k}${(view.focusEpoch ?? 0) % 2 === 1 ? '~' : ''}`
    const bump = (v: InsightView) => (v.focusEpoch ?? 0) + 1
    // 每个会话一张带边框的小卡片：上下内边距收紧，不比项目头的大卡片抢眼
    const rowCard = e.surface === 'terminal' ? card : ({ ...card, paddingY: 'xs' } as const)
    /** 一个会话行：两行。第 1 行标题与标签，右侧时间；第 2 行账号 · token · 最后一条消息（窄档没有最后消息，改放时间） */
    const renderSessionRow = (s: (typeof sorted)[number]) => {
      const acctName =
        view.account === undefined && accountIds.length > 1 && s.account !== undefined ? (
          <Text color={acctColor(s.account)}>
            {accountLabel(accounts, s.account).replace('（当前）', '').replace(/@.*/, '')}
            <Text dimColor> · </Text>
          </Text>
        ) : null
      // 终端里恢复必须在会话所在目录下才找得到它，所以带上 cd
      const resumeCmd = `${s.cwd ? `cd ${shellQuote(s.cwd)} && ` : ''}claude --resume ${s.id}`
      // 在 Claude Desktop 里开的会话直接打开；Desktop 只打得开当前登录账号的会话，其余（他号、纯终端会话、终端界面）复制恢复命令
      const desktopId = accounts.desktopBySession?.[s.id]
      const isOwnAccount = s.account !== undefined && s.account === accounts.current
      const canOpen = desktopId !== undefined && isOwnAccount && e.surface !== 'terminal'
      const archived = accounts.desktopMeta?.[s.id]?.isArchived === true
      // 标题就是这一行唯一的可聚焦主操作：点击面积大，长列表里的控件也少
      // （按钮越多，宿主「保持焦点可见」的自动滚动越容易和用户滚动抢位置）
      const act = async () => {
        // 按下后换 key，让焦点环离开这个按钮（见 fk）
        await setViewState($, v => ({ ...v, focusEpoch: bump(v) }))
        if (canOpen) {
          await openInDesktop($, `claude://claude.ai/epitaxy/${desktopId}`, e.surface, archived)
        } else {
          await $.ui.copy({ text: resumeCmd, surface: e.surface })
          $.ui.toast(`已复制恢复命令：${resumeCmd}`, { timeoutMs: 6000 })
        }
      }
      // 默认行为（打开）不提示；只有「点了是复制命令」的例外才标出来。终端里全都是复制，由模块标题旁的一句话说明
      const showCopyHint = !canOpen && e.surface !== 'terminal'
      // 标签放在按钮外面：按钮里的文字字号、颜色会被宿主统一覆盖，标签就和标题混成一串了
      const title = (
        <Box flexDirection="row" alignItems="center" columnGap={1} minWidth={0}>
          <Box flexShrink={1} minWidth={0}>
            <Button key={fk(`open-${s.id}`)} plain onPress={() => void act()}>
              <Text wrap="truncate-end" weight="medium">
                {s.title}
              </Text>
            </Button>
          </Box>
          {s.id === currentSessionId ? (
            <Text color={ACCENT} size="footnote">
              当前
            </Text>
          ) : null}
          {archived ? (
            <Text dimColor size="footnote">
              已归档
            </Text>
          ) : null}
          {showCopyHint ? (
            <Text dimColor size="footnote">
              复制命令
            </Text>
          ) : null}
        </Box>
      )
      const ago = fmtAgo(now - s.lastAt)
      const tokens = `${fmtTokens(tokensOf(s.r))} token`
      return (
        <Box key={`s-${s.id}`} flexDirection="column" {...rowCard}>
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={2}>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              {title}
            </Box>
            {isNarrow ? null : (
              <Text dimColor size="footnote" tabular>
                {ago}
              </Text>
            )}
          </Box>
          {/* 左边留出和标题按钮内边距相同的一段，两行才对得齐 */}
          <Box paddingLeft="xs">
            <Text size="footnote" wrap="truncate-end">
              {acctName}
              <Text dimColor>
                {isNarrow ? `${ago} · ${tokens}` : tokens}
                {!isNarrow && s.lastPrompt && s.hasTitle ? ` · ${s.lastPrompt}` : ''}
              </Text>
            </Text>
          </Box>
        </Box>
      )
    }

    // ----- 版面 -----
    const tree = (
      <Box flexDirection="column" gap={4} paddingX={1} paddingY={1}>
        {/* 工具栏：左边小标题，右边（右对齐）扫描进度、账号与设置 */}
        <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" rowGap={1} columnGap={2}>
          {/* 小标题：Desktop 只开一个插件面板时不显示面板标题（外层标签固定叫「插件」），面板里自己写上名字 */}
          <Text weight="semibold">{TITLE}</Text>
          <Box flexDirection="row" columnGap={1} alignItems="center">
            {scan.isRunning ? (
              <Text dimColor size="footnote" tabular>
                扫描中 {pctDone}%
              </Text>
            ) : null}
            <Button
              key="open-settings"
              label={tab === 'settings' ? '‹ 返回' : '⚙\uFE0E 插件设置'}
              variant="secondary"
              onPress={() => setView(v => ({ ...v, tab: v.tab === 'settings' ? 'overview' : 'settings' }))}
            />
            {accountIds.length > 0 && tab !== 'settings' ? (
              <Select
                key="account"
                options={accountOptions}
                value={view.account ?? 'all'}
                onSelect={value => setView(v => ({ ...v, account: value === 'all' ? undefined : value, page: 0 }))}
              />
            ) : null}
            {/* 关闭：Desktop 标签上的 × 与 Cmd+\ 关不掉插件面板，由插件自己调 $.ui.close */}
            {e.surface === 'terminal' ? null : (
              <Button
                key="close-pane"
                label="✕"
                plain
                dimColor
                role="dismiss"
                onPress={() => void $.ui.close({ id: PANE }).catch(() => undefined)}
              />
            )}
          </Box>
        </Box>

        {scan.error ? <Text color="error">扫描出错：{scan.error}</Text> : null}

        {/* 一整页，与原型一致：额度 → 用量 → 工具 → 会话；设置页单独一页 */}
        {tab !== 'settings' ? (
          <Box flexDirection="column" gap={4}>
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
              {/* 账号并排、放不下自动换行：每个账号按自身内容的实际宽度占位，由宿主排版决定是否换行，
                  插件里不估算任何宽度。两个放得下就一行两列，放不下第二个换到下一行并铺满 */}
              <Box flexDirection="row" flexWrap="wrap" columnGap={4} rowGap={3}>
                {shownLimits.map(r => (
                  <Box
                    key={`quota-${r.account}`}
                    flexDirection="column"
                    gap={1}
                    flexGrow={1}
                    flexShrink={0}
                  >
                    {limitRows.length > 1 || !r.isLive ? (
                      <Text dimColor size="footnote" wrap="truncate-end">
                        {accountLabel(accounts, r.account === 'current' ? undefined : r.account).replace('未归属', '当前账号')}
                        {r.isLive ? '' : ` · ${fmtAgo(now - r.at)}的读数`}
                      </Text>
                    ) : null}
                    {r.windows.map(w => quotaRow(`q-${r.account}-${w.kind}`, w, !r.isLive))}
                  </Box>
                ))}
              </Box>
            </Section>

            {/* 花费：总数、每天、花在哪 */}
            {spendCard}


            {/* 会话：以项目为主线，项目一行（会话数 · 最近活动 · 成本与占比），展开后列出它的会话 */}
            <Section
              title="会话"
              note={
                listed.length === 0
                  ? undefined
                  : activePick
                    ? `${groups.length} 个项目 · ${sorted.length} 个会话用过${RANK_NOUN[activePick.kind]}「${pickLabel}」`
                    : `${groups.length} 个项目 · ${sorted.length} 个会话${e.surface === 'terminal' ? ' · 点击会话复制恢复命令' : ''}`
              }
            >
              {/* 账号图例：色点对应哪个账号；点一下只看该账号。只有多个账号且在「全部」视图时显示 */}
              {accountIds.length > 1 && view.account === undefined ? (
                <Box flexDirection="row" flexWrap="wrap" columnGap={3} rowGap={0} alignItems="center">
                  <Text dimColor size="footnote">
                    账号
                  </Text>
                  {accountIds.map(id => (
                    // 色点放在按钮外面：按钮里的文字颜色会被宿主覆盖成统一的前景色，圆点就变白了
                    <Box key={`acct-${id}`} flexDirection="row" alignItems="center" columnGap={1}>
                      <Text color={acctColor(id)}>●</Text>
                      <Button
                        key={`acct-btn-${id}`}
                        label={accountLabel(accounts, id)}
                        plain
                        onPress={() => setView(v => ({ ...v, account: id, page: 0 }))}
                      />
                    </Box>
                  ))}
                </Box>
              ) : null}
              {/* 工具行：左边搜索，右边排序（输入框宽度由宿主决定，和排序同排更自然） */}
              <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={3} rowGap={1}>
                {listed.length > 0 ? (
                  <Input
                    key="session-search"
                    placeholder="搜索会话"
                    value={view.query ?? ''}
                    submitLabel="搜索"
                    onInput={value => setView(v => ({ ...v, query: value.trim() ? value : undefined, page: 0, sessionPage: 0, openProjects: undefined }))}
                    onSubmit={value => setView(v => ({ ...v, query: value.trim() ? value : undefined, page: 0, sessionPage: 0, openProjects: undefined }))}
                  />
                ) : (
                  <Box />
                )}
                <Box flexDirection="row" columnGap={1}>
                  {SORTS.map(([st, label]) => (
                    <Button
                      key={`sort-${st}`}
                      label={label}
                      plain
                      dimColor={sortMode !== st}
                      onPress={() => setView(v => ({ ...v, sort: st, page: 0, sessionPage: 0 }))}
                    />
                  ))}
                </Box>
              </Box>
              {activePick ? (
                <Button
                  key="clear-pick"
                  label={`✕ 清除筛选（${RANK_NOUN[activePick.kind]}：${pickLabel}）`}
                  plain
                  dimColor
                  onPress={() => setView(v => ({ ...v, pick: undefined }))}
                />
              ) : null}
              {listed.length === 0 ? (
                <Text dimColor>{scan.isRunning ? '正在扫描…' : '还没有会话。'}</Text>
              ) : isFiltering && sorted.length === 0 ? (
                <Text dimColor>没有符合筛选条件的会话。</Text>
              ) : null}
              <Box flexDirection="column" gap={1} minHeight={sessionBodyRows} justifyContent="space-between">
              <Box flexDirection="column" gap={1}>
                {visibleGroups.map(g => {
                  const isOpen = isProjectOpen(g.name)
                  const sessionPages = Math.max(1, Math.ceil(g.sessions.length / SESSIONS_PER_PAGE))
                  const sessionPage = Math.min(Math.max(0, view.sessionPage ?? 0), sessionPages - 1)
                  const shown = g.sessions.slice(sessionPage * SESSIONS_PER_PAGE, (sessionPage + 1) * SESSIONS_PER_PAGE)
                  // 点开一个：其他项目隐藏；再点已展开的收起，回到项目列表（空数组）
                  // 按下后焦点环会停在这个按钮上，宿主又会「保持焦点可见」：往下滚走后被拉回，就是抖动。
                  // 所以每次按下都给按钮换个 key（fk），原来的元素消失，焦点环不再钉在滚出视野的按钮上
                  const toggle = async () => {
                    await setViewState($, v => ({ ...v, openProjects: isOpen ? [''] : [g.name], sessionPage: 0, focusEpoch: bump(v) }))
                  }
                  // 收起时的项目头多给一个小提示：含当前会话
                  const hasCurrent = g.sessions.some(x => x.id === currentSessionId)
                  return (
                    <Box key={`proj-${g.name}`} flexDirection="column" gap={1}>
                      {/* 项目行：› 名称 ··· 会话数 · 最近活动 ｜ token 消耗 ｜ 占比。克制：不画进度条，靠排版与留白区分层级 */}
                      <Box flexDirection="row" alignItems="center" columnGap={3}>
                        <Box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="row" alignItems="center" columnGap={2}>
                          <Button key={fk(`proj-toggle-${g.name}`)} plain onPress={() => void toggle()}>
                            <Text wrap="truncate-end" weight={isOpen ? 'semibold' : 'medium'}>
                              {isOpen ? '‹  ' : '›  '}
                              {g.name}
                            </Text>
                          </Button>
                          {!isOpen && hasCurrent ? (
                            <Text color={ACCENT} size="footnote">
                              含当前
                            </Text>
                          ) : null}
                        </Box>
                        {isNarrow ? null : (
                          <Text dimColor size="footnote" tabular>
                            {g.sessions.length} 个 · {fmtAgo(now - g.lastAt)}
                          </Text>
                        )}
                        <Box minWidth={isNarrow ? 7 : 9} justifyContent="flex-end">
                          <Text tabular>{fmtTokens(g.tokens)}</Text>
                        </Box>
                      </Box>
                      {isOpen ? (
                        <Box flexDirection="column" gap={1} paddingTop={1}>
                          {shown.map(s => renderSessionRow(s))}
                        </Box>
                      ) : null}
                    </Box>
                  )
                })}
              </Box>
              {/* 会话分页器：固定在模块底部，每一页位置不变 */}
              {openGroup && openPages > 1 ? (
                <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
                  <Button
                    key={fk(`sess-prev-${openGroup.name}`)}
                    label="‹ 上一页"
                    plain
                    dimColor={openPage === 0}
                    onPress={() => setView(v => ({ ...v, sessionPage: Math.max(0, openPage - 1), focusEpoch: bump(v) }))}
                  />
                  <Text dimColor size="footnote" tabular>
                    第 {openPage + 1} / {openPages} 页 · 共 {openGroup.sessions.length} 个会话
                  </Text>
                  <Button
                    key={fk(`sess-next-${openGroup.name}`)}
                    label="下一页 ›"
                    plain
                    dimColor={openPage >= openPages - 1}
                    onPress={() => setView(v => ({ ...v, sessionPage: Math.min(openPages - 1, openPage + 1), focusEpoch: bump(v) }))}
                  />
                </Box>
              ) : null}
              {projectPages > 1 && openProject === undefined ? (
                <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
                  <Button
                    key="proj-page-prev"
                    label="‹ 上一页"
                    plain
                    dimColor={projectPage === 0}
                    onPress={() => setView(v => ({ ...v, page: Math.max(0, projectPage - 1) }))}
                  />
                  <Text dimColor size="footnote" tabular>
                    项目 {projectPage + 1} / {projectPages}
                  </Text>
                  <Button
                    key="proj-page-next"
                    label="下一页 ›"
                    plain
                    dimColor={projectPage >= projectPages - 1}
                    onPress={() => setView(v => ({ ...v, page: Math.min(projectPages - 1, projectPage + 1) }))}
                  />
                </Box>
              ) : null}
              </Box>
            </Section>
          </Box>
        ) : null}

        {settingsPage}
      </Box>
    )
    insightsMemo = { sig, tree }
    return tree
}
