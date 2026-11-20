import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  AccountMap,
  Activity,
  CategoryRow,
  RateSnapshot,
  RateWindow,
  Snapshot,
  StepRecord,
  StepTotals,
} from '../types'
import { ACCENT, BLUE, GREY, ORANGE, PALETTE, contextTrendSvg, stackSvg, svgSize } from './charts'
import { groupTools, renderInsights, renderSessionDetail, startInsights } from './insights'
import { runScan } from './scan'
import type { PaneInput } from './insights'
import { bump, cardStyle, dropMisfiledLimits, fmtTokens, sessionAccount, fmtUntil, fmtUsd, paneWidths, pct, programOf, sparkline, textBar, topEntries, windowLabel } from './util'

const PLUGIN = 'cc-context-insights'
const PANE = 'cc-context-insights'
const TITLE = '上下文洞察'
const MAX_STEPS = 300

// 面板默认是洞察总览；在会话列表里双击某个会话，就切到那个会话的上下文（focus = 会话 id）
const focusAtom = atom({ plugin: 'cc-context-insights', key: 'focus' } as const, null as string | null, {
  shape: 'focus-1',
})

async function renderMain($: EngineInterface, e: PaneInput): Promise<JSX.Element> {
  const focus = await read($, focusAtom)
  if (focus === null) return renderInsights($, e)
  const { Box, Button, Text } = $.ui.resolve(e)
  const currentId = await $.session.id().catch(() => undefined)
  const isCurrent = focus === currentId
  // 当前会话：实时数据（含窗口构成）；其他会话：从日志还原
  const body = isCurrent ? await renderSession($, e) : await renderSessionDetail($, e, focus)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2} paddingX={1} paddingTop={1} alignItems="center">
        <Button key="back" label="← 返回洞察" plain dimColor onPress={() => void update($, focusAtom, () => null)} />
        {isCurrent ? (
          <Text dimColor size="footnote">
            当前会话 · 实时
          </Text>
        ) : null}
      </Box>
      {body}
    </Box>
  )
}

// 字段变了就改 shape：旧版本存下的值会被丢弃，而不是读成错的形状
const steps = atom({ plugin: 'cc-context-insights', key: 'steps' } as const, [] as StepRecord[], {
  shape: 'steps-1',
})
/** 整个会话的请求累计：steps 只留最近 MAX_STEPS 条画趋势，统计数字不能跟着截断 */
const NO_TOTALS: StepTotals = { count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const stepTotals = atom({ plugin: 'cc-context-insights', key: 'step-totals' } as const, NO_TOTALS, {
  shape: 'step-totals-1',
})
const turns = atom({ plugin: 'cc-context-insights', key: 'turns' } as const, 0, { shape: 'turns-1' })
const EMPTY_ACTIVITY: Activity = {
  tools: {},
  errors: 0,
  reads: 0,
  writes: 0,
  searches: 0,
  files: {},
  programs: {},
}
const activity = atom({ plugin: 'cc-context-insights', key: 'activity' } as const, EMPTY_ACTIVITY, {
  shape: 'activity-1',
})
const snapshot = atom({ plugin: 'cc-context-insights', key: 'snapshot' } as const, null as Snapshot | null, {
  shape: 'snapshot-1',
})
const busy = atom({ plugin: 'cc-context-insights', key: 'busy' } as const, false, { shape: 'busy-1' })
// 与 insights.tsx / scan.ts 共用
const NO_ACCOUNTS: AccountMap = { bySession: {}, labels: {} }
const accountsAtom = atom({ plugin: 'cc-context-insights', key: 'accounts' } as const, NO_ACCOUNTS, { shape: 'accounts-1' })
const limitsAtom = atom({ plugin: 'cc-context-insights', key: 'limits' } as const, {} as Record<string, RateSnapshot>, {
  shape: 'limits-1',
})
/** 额度快照跨会话保存（$.state 只活在本会话），切换账号后另一个账号的最后读数仍可显示 */
export const LIMITS_STORE_KEY = 'limits-1'

/** 记下当前账号这一刻的额度 */
async function saveLimits($: EngineInterface, windows: RateWindow[], at: number): Promise<void> {
  if (windows.length === 0) return
  const sessionId = await $.session.id().catch(() => undefined)
  const account = sessionAccount(await read($, accountsAtom), sessionId)
  if (account === undefined) {
    // 账号还没加载完（会话刚开始时扫描尚未跑到 loadAccounts）：只放进本会话状态，
    // 不落到 $.store，免得在兜底键下留一份永远不会被读的旧读数
    await update($, limitsAtom, cur => ({ ...cur, current: { at, windows } }))
    return
  }
  const stored = ((await $.store.get(LIMITS_STORE_KEY)) ?? {}) as Record<string, RateSnapshot>
  const { current: _stale, ...rest } = stored
  // 同一份读数若还挂在别的账号下（以前认错账号时存的），一并清掉
  const next = { ...dropMisfiledLimits(rest, account, windows), [account]: { at, windows } }
  await $.store.set(LIMITS_STORE_KEY, next)
  await update($, limitsAtom, cur => {
    const { current: _early, ...curRest } = cur
    return { ...dropMisfiledLimits(curRest, account, windows), ...next }
  })
}

// ---------- 工具调用归类 ----------

const READ_TOOLS = new Set(['Read', 'NotebookRead'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'ToolSearch'])


// ---------- 刷新上下文快照 ----------

/** 正在刷新时又要求精确统计：记下来，本次结束后补做，不能丢 */
let pendingFull = false
/** 同步重入锁，避免两次紧邻调用在 await read(busy) 之间同时进入 */
let refreshing = false

async function refresh($: EngineInterface, detail: 'summary' | 'full'): Promise<void> {
  if (refreshing || (await read($, busy))) {
    if (detail === 'full') pendingFull = true
    return
  }
  refreshing = true
  if (detail === 'full') pendingFull = false
  await update($, busy, () => true)
  try {
    const usage = await $.session.usage({ breakdown: detail })
    const b = usage.context.breakdown
    const categories: CategoryRow[] = (b?.categories ?? []).map(c => ({
      name: c.name,
      tokens: c.tokens,
      kind: c.kind,
      color: c.color,
    }))
    const next: Snapshot = {
      at: await $.clock.now(),
      model: b?.model,
      tokens: usage.context.tokens,
      window: usage.context.window,
      percent: usage.context.percent,
      usd: usage.cost?.usd,
      hasUnknownPrice: usage.cost?.hasUnknownPrice,
      detail,
      categories,
      autoCompactAt: b?.autoCompactThreshold,
      memoryFiles: b?.memoryFiles.length ?? 0,
      mcpTools: b?.mcpTools.length ?? 0,
      skills: b?.skills?.totalSkills ?? 0,
    }
    await update($, snapshot, () => next)
    await saveLimits(
      $,
      usage.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
      next.at,
    )
  } catch (err) {
    $.ui.log(`${PLUGIN}: 刷新失败 ${String(err)}`)
  } finally {
    refreshing = false
    await update($, busy, () => false)
    if (pendingFull) {
      pendingFull = false
      void refresh($, 'full')
    }
  }
}

// ---------- 注册 ----------

export const register: Register = on => {
  /**
   * /ctx-insights 是面板唯一的入口（命令在 startInsights 里注册）：
   * 打开「上下文洞察」总览，并增量扫描日志；
   * `/ctx-insights full`：直接进入当前会话的上下文并做一次精确统计。
   */
  // 匹配器用字面量，校验器才能静态看出它对应哪个命令
  on('command.run', { command: 'ctx-insights' }, async ($, e) => {
    const isFull = e.args.trim() === 'full'
    const currentId = isFull ? await $.session.id().catch(() => null) : null
    await update($, focusAtom, () => currentId)
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true }).catch(() => undefined)
    void runScan($)
    void refresh($, isFull ? 'full' : 'summary')
    return {
      text:
        opened?.isPlaced === false
          ? `上下文洞察暂未显示：${opened.reason}`
          : isFull
            ? '已打开上下文洞察，正在精确统计本会话的上下文。'
            : '已打开上下文洞察。',
      isTextDisplayOnly: true,
    }
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($, 'summary')
    await startInsights($).catch(err => $.ui.log(`${PLUGIN}: 洞察启动失败 ${String(err)}`))
    return started
  })

  // 每次模型请求：记下主循环的 token 用量
  on('turn.step', async function* ($, e, next) {
    // 流式事件：原样转发分块，拿到最终结果
    const result = yield* next(e)
    const u = result.usage
    if (e.agentId === undefined && u) {
      const rec: StepRecord = {
        at: await $.clock.now(),
        ctx: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
        model: u.model,
        tools: result.toolUses.length,
      }
      await update($, steps, list => [...list, rec].slice(-MAX_STEPS))
      await update($, stepTotals, t => ({
        count: t.count + 1,
        input: t.input + rec.input,
        output: t.output + rec.output,
        cacheRead: t.cacheRead + rec.cacheRead,
        cacheWrite: t.cacheWrite + rec.cacheWrite,
      }))
    }
    return result
  })

  // 每轮结束：轮次 +1，并免费估算一次组成
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await update($, turns, n => n + 1)
      void refresh($, 'summary')
    }
    return result
  })

  // 工具、文件、命令活动
  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    const args = e as unknown as Record<string, unknown>
    // NotebookEdit 的路径参数叫 notebook_path
    const path =
      typeof args.file_path === 'string'
        ? args.file_path
        : typeof args.notebook_path === 'string'
          ? args.notebook_path
          : undefined
    const command = typeof args.command === 'string' ? args.command : undefined
    const ran = await next(e)
    // 统计失败不能影响工具结果
    await update($, activity, a => {
      const out: Activity = { ...a, tools: bump(a.tools, name) }
      if (ran.isError === true || ran.deny !== undefined) out.errors = a.errors + 1
      if (READ_TOOLS.has(name)) out.reads = a.reads + 1
      if (WRITE_TOOLS.has(name)) out.writes = a.writes + 1
      if (SEARCH_TOOLS.has(name)) out.searches = a.searches + 1
      if (path !== undefined && (READ_TOOLS.has(name) || WRITE_TOOLS.has(name))) {
        const f = a.files[path] ?? { r: 0, w: 0 }
        const isWrite = WRITE_TOOLS.has(name)
        out.files = { ...a.files, [path]: { r: f.r + (isWrite ? 0 : 1), w: f.w + (isWrite ? 1 : 0) } }
      }
      if (name === 'Bash' && command !== undefined) {
        const prog = programOf(command)
        if (prog !== undefined) out.programs = bump(a.programs, prog)
      }
      return out
    }).catch(() => undefined)
    return ran
  })

  // 「上下文洞察」面板：默认总览，双击会话进入它的上下文
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => renderMain($, e))
}

/** 「本会话」标签页的内容：窗口占用、构成、趋势、本会话统计、活动、子 Agent */
async function renderSession($: EngineInterface, e: PaneInput): Promise<JSX.Element> {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // 终端的元素表里也有 Svg，但画不出来：按绘制端判断，终端用文字兜底
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const card = cardStyle(e.surface)
    // 显式给宽高（不给高度时桌面端内嵌框默认 150px）。宽度也要给：不给时宿主会把图放大铺满面板、底部被裁。
    // 高度多留 4%，防宽度略估大时被等比缩放后裁底
    const Chart = (p: { source: string; alt: string; isInteractive?: boolean }) => {
      if (!Svg) return null
      const size = svgSize(p.source)
      return (
        <Svg
          source={p.source}
          alt={p.alt}
          width={size.width}
          height={Math.ceil(size.height * 1.04) + 2}
          isInteractive
        />
      )
    }
    const snap = await read($, snapshot)
    const list = await read($, steps)
    const turnCount = await read($, turns)
    const act = await read($, activity)
    const isBusy = await read($, busy)
    const agents = await $.agent.list().catch(() => [])
    const now = await $.clock.now()
    const allLimits = await read($, limitsAtom)
    const myAccount = sessionAccount(await read($, accountsAtom), await $.session.id().catch(() => undefined))
    // 账号加载前的读数暂记在 'current' 下（只在本会话状态里）
    const mine = myAccount !== undefined ? allLimits[myAccount] : undefined
    const early = allLimits.current
    const myLimits = mine && early ? (early.at > mine.at ? early : mine) : (mine ?? early)
    const cols = e.props.bodyColumns
    const { full } = paneWidths(cols)

    // ----- 数据 -----
    const sum = await read($, stepTotals)
    const prompted = sum.input + sum.cacheRead + sum.cacheWrite
    const last = list[list.length - 1]
    const prev = list[list.length - 2]
    const delta = last && prev ? last.ctx - prev.ctx : undefined

    const window = snap?.window ?? 0
    const tokens = snap?.tokens ?? last?.ctx
    const percent = snap?.percent ?? (tokens !== undefined && window > 0 ? Math.round((tokens / window) * 100) : undefined)
    const used = [...(snap?.categories.filter(c => c.kind === 'used' && c.tokens > 0) ?? [])].sort((a, b) => b.tokens - a.tokens)
    const free = snap?.categories.find(c => c.kind === 'free')
    const buffer = snap?.categories.find(c => c.kind === 'buffer')
    const deferred = snap?.categories.filter(c => c.kind === 'deferred' && c.tokens > 0) ?? []
    const colorAt = (i: number) => PALETTE[i % PALETTE.length] ?? BLUE
    const toCompact =
      snap?.autoCompactAt !== undefined && tokens !== undefined ? Math.max(0, snap.autoCompactAt - tokens) : undefined

    const totalCalls = Object.values(act.tools).reduce((s, n) => s + n, 0)
    const topFiles = Object.entries(act.files)
      .sort((a, b) => b[1].r + b[1].w - (a[1].r + a[1].w))
      .slice(0, 5)
    const trend = list.slice(-60).map(s => s.ctx)

    // ----- 小组件 -----
    const Section = (props: { title: string; note?: string; right?: JSX.Element | null; children?: unknown }) => (
      <Box flexDirection="column" gap={1} {...card}>
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
    const row = (key: string, left: JSX.Element, right: string) => (
      <Box key={key} flexDirection="row" justifyContent="space-between" columnGap={2}>
        {left}
        <Text tabular dimColor>
          {right}
        </Text>
      </Box>
    )
    /** 三列图例：■ 名称 · 数量（灰）· 占比，与 Claude 原生上下文用量界面一致 */
    const legend3 = (key: string, color: string, name: string, value: number, base: number, isDim = false) => (
      <Box key={key} flexDirection="row" alignItems="center" columnGap={2}>
        <Box flexDirection="row" flexGrow={1} columnGap={1}>
          <Text color={color === 'track' ? undefined : color} dimColor={color === 'track'}>
            {color === 'track' ? '□' : '■'}
          </Text>
          <Text wrap="truncate-end" dimColor={isDim}>
            {name}
          </Text>
        </Box>
        <Box minWidth={8} justifyContent="flex-end">
          <Text tabular dimColor>
            {fmtTokens(value)}
          </Text>
        </Box>
        <Box minWidth={7} justifyContent="flex-end">
          <Text tabular dimColor={isDim}>
            {pct(value, base || 1)}
          </Text>
        </Box>
      </Box>
    )
    const stat = (label: string, value: string) => (
      <Box flexDirection="column" minWidth={9}>
        <Text dimColor size="caption">
          {label}
        </Text>
        <Text weight="semibold" tabular>
          {value}
        </Text>
      </Box>
    )

    // ----- 版面 -----
    return (
      <Box flexDirection="column" gap={4} paddingX={1} paddingY={1}>
        {/* 窗口占用：版式对齐 Claude 自己的上下文用量界面 */}
        <Box flexDirection="column" gap={1} {...card}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="flex-end" columnGap={2}>
            <Text size="heading" weight="medium" tabular color={(percent ?? 0) >= 80 ? ORANGE : undefined}>
              已使用 {percent === undefined ? '—' : `${percent}%`}
            </Text>
            <Text dimColor tabular>
              {fmtTokens(tokens)} / {fmtTokens(window || undefined)}
            </Text>
          </Box>
          {Svg ? (
            <Chart
              source={stackSvg(
                [
                  ...used.map((c, i) => ({ name: c.name, value: c.tokens, color: colorAt(i), note: fmtTokens(c.tokens) })),
                  ...(buffer ? [{ name: buffer.name, value: buffer.tokens, color: '#C8C8C8', note: fmtTokens(buffer.tokens) }] : []),
                  ...(free ? [{ name: free.name, value: free.tokens, color: 'track', note: fmtTokens(free.tokens) }] : []),
                ],
                full,
              )}
              alt="上下文窗口占用"
              isInteractive
            />
          ) : (
            <Text color={(percent ?? 0) >= 80 ? ORANGE : ACCENT}>{textBar(percent ?? 0, Math.max(10, Math.min(40, cols - 4)))}</Text>
          )}
          {used.length === 0 ? <Text dimColor>发一条消息后自动统计。</Text> : null}
          <Box flexDirection="column">
            {used.map((c, i) => legend3(`cat-${c.name}`, colorAt(i), c.name, c.tokens, window))}
            {buffer ? legend3('cat-buffer', GREY, buffer.name, buffer.tokens, window, true) : null}
            {free ? legend3('cat-free', 'track', free.name, free.tokens, window, true) : null}
          </Box>
          {myLimits && myLimits.windows.length > 0 ? (
            <Text size="footnote">
              <Text dimColor>订阅额度 </Text>
              {myLimits.windows.map((w, i) => {
                // 与总览一致：重置时间已过的读数作废，非法时间不显示
                const resetAt = w.resetsAt ? Date.parse(w.resetsAt) : NaN
                const isReset = !Number.isNaN(resetAt) && resetAt <= now
                return (
                  <Text key={`lim-${w.kind}`}>
                    {i > 0 ? <Text dimColor> · </Text> : null}
                    <Text dimColor>{windowLabel(w.kind)} </Text>
                    <Text color={!isReset && w.percentUsed >= 80 ? ORANGE : undefined} dimColor={isReset} weight="medium">
                      {isReset ? '—' : `${w.percentUsed}%`}
                    </Text>
                    {isReset ? (
                      <Text dimColor>（已重置）</Text>
                    ) : Number.isNaN(resetAt) ? null : (
                      <Text dimColor>（{fmtUntil(resetAt - now)}后重置）</Text>
                    )}
                  </Text>
                )
              })}
            </Text>
          ) : null}
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2} flexWrap="wrap">
            <Text dimColor size="footnote">
              {snap?.model ?? last?.model ?? '模型未知'}
              {toCompact !== undefined ? ` · 距自动压缩还有 ${fmtTokens(toCompact)}` : snap ? ' · 自动压缩已关闭' : ''}
              {delta !== undefined ? ` · 上次请求 ${delta >= 0 ? '+' : ''}${fmtTokens(delta)}` : ''}
            </Text>
            <Button
              key="refresh-full"
              label={isBusy ? '统计中…' : snap?.detail === 'full' ? '已精确统计 · 重新统计' : '估算值 · 精确统计'}
              plain
              dimColor
              onPress={() => void refresh($, 'full')}
            />
          </Box>
          {snap && (deferred.length > 0 || snap.memoryFiles + snap.mcpTools + snap.skills > 0) ? (
            <Text dimColor size="footnote">
              {snap.memoryFiles} 个记忆文件 · {snap.mcpTools} 个 MCP 工具 · {snap.skills} 个技能
              {deferred.length > 0 ? ` · 按需加载 ${fmtTokens(deferred.reduce((s, d) => s + d.tokens, 0))}（不占窗口）` : ''}
            </Text>
          ) : null}
        </Box>

        {/* 趋势 */}
        <Section title="趋势" note={trend.length >= 2 ? `最近 ${trend.length} 次请求` : undefined}>
          {trend.length < 2 ? (
            <Text dimColor>两次请求后显示。</Text>
          ) : Svg ? (
            <Chart source={contextTrendSvg(trend, window || Math.max(...trend), snap?.autoCompactAt, full)} alt="逐请求上下文大小" isInteractive />
          ) : (
            <Text color={ACCENT}>{sparkline(trend.slice(-Math.max(10, cols - 4)), window || Math.max(...trend))}</Text>
          )}
        </Section>

        {/* 本会话 */}
        <Section title="本会话">
          <Box flexDirection="row" flexWrap="wrap" columnGap={3} rowGap={1}>
            {stat('等价 API 成本', fmtUsd(snap?.usd))}
            {stat('轮次', String(turnCount))}
            {stat('请求', String(sum.count))}
            {stat('缓存命中', pct(sum.cacheRead, prompted))}
            {stat('输出', fmtTokens(sum.output))}
          </Box>
        </Section>

        {/* 活动 */}
        {totalCalls > 0 ? (
          <Section title="活动" note={`${totalCalls} 次工具调用${act.errors > 0 ? ` · ${act.errors} 次失败` : ''}`}>
            <Text>
              {topEntries(groupTools(act.tools), 5)
                .map(([k, v]) => `${k} ${v}`)
                .join(' · ')}
            </Text>
            {topFiles.length > 0 ? (
              <Box flexDirection="column">
                {topFiles.map(([p, f]) =>
                  row(
                    `file-${p}`,
                    <Text wrap="truncate-start">{p.split('/').slice(-2).join('/')}</Text>,
                    [f.r > 0 ? `读 ${f.r}` : '', f.w > 0 ? `写 ${f.w}` : ''].filter(Boolean).join(' · '),
                  ),
                )}
              </Box>
            ) : null}
            {Object.keys(act.programs).length > 0 ? (
              <Text dimColor size="footnote">
                命令：
                {topEntries(act.programs, 8)
                  .map(([k, v]) => `${k}×${v}`)
                  .join('  ')}
              </Text>
            ) : null}
          </Section>
        ) : null}

        {/* 子 Agent */}
        {agents.length > 0 ? (
          <Section title="子 Agent" note={`${agents.length} 个`}>
            <Box flexDirection="column">
              {agents.slice(-8).map(a =>
                row(
                  `agent-${a.id}`,
                  <Text wrap="truncate-end">
                    <Text color={a.taskStatus === 'running' ? ACCENT : undefined} dimColor={a.taskStatus !== 'running'}>
                      {a.taskStatus === 'running' ? '● ' : '○ '}
                    </Text>
                    {a.label}
                  </Text>,
                  `${fmtTokens(a.tokenCount)} · ${fmtUsd(a.cost?.usd)}`,
                ),
              )}
            </Box>
          </Section>
        ) : null}

        <Text dimColor size="caption">
          等价 API 成本是按标价折算的本地估算，订阅用户不按它计费。请求与活动从面板加载后开始累计。
        </Text>
      </Box>
    )
}
