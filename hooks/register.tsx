import type { EngineInterface, Register } from 'claude-code'

import type {
  Activity,
  CategoryRow,
  FileFilter,
  InsightView,
  RateSnapshot,
  RateWindow,
  Snapshot,
  StepRecord,
} from '../types'
import { ACCENT, BLUE, GREY, ORANGE, PALETTE, contextTrendSvg, stackSvg, svgSize } from './charts'
import { groupTools, renderInsights, startInsights } from './insights'
import { runScan } from './scan'
import type { PaneInput } from './insights'
import {
  getAccounts,
  getActivity,
  getBusy,
  getFocus,
  getLimits,
  getScan,
  getSnapshot,
  getSteps,
  getStepTotals,
  getTurns,
  getView,
  LIMITS_STORE_KEY,
  MAX_STEPS,
  noteLiveLimits,
  PANE,
  PLUGIN,
  setActivity,
  setBusy,
  setFocus,
  setLimits,
  setSnapshot,
  setSteps,
  setStepTotals,
  setTurns,
  setViewState,
  TITLE,
  PANE_COLUMNS,
} from './state'

import {
  bump,
  cardStyle,
  detectContextDrops,
  dropMisfiledLimits,
  filterFiles,
  fmtClockTime,
  fmtTokens,
  fmtUntil,
  fmtUsd,
  paneWidths,
  pct,
  programOf,
  sessionAccount,
  shortFilePath,
  sparkline,
  textBar,
  topEntries,
  windowLabel,
} from './util'

export { LIMITS_STORE_KEY }

async function renderMain($: EngineInterface, e: PaneInput): Promise<JSX.Element> {
  const focus = await getFocus($)
  if (focus === null) return renderInsights($, e)
  const { Box, Button, Text } = $.ui.resolve(e)
  // 只有当前会话有详情页（实时数据，含窗口构成）；焦点不是当前会话时回到总览
  const currentId = await $.session.id().catch(() => undefined)
  if (focus !== currentId) return renderInsights($, e)
  const body = await renderSession($, e)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2} paddingX={1} paddingTop={1} alignItems="center">
        <Button key="back" label="← 返回洞察" plain dimColor onPress={() => void setFocus($, () => null)} />
        <Text dimColor size="footnote">
          当前会话 · 实时
        </Text>
      </Box>
      {body}
    </Box>
  )
}

/** 记下当前账号这一刻的额度 */
async function saveLimits($: EngineInterface, windows: RateWindow[], at: number): Promise<void> {
  await noteLiveLimits($, windows, at)
  if (windows.length === 0) return
  const sessionId = await $.session.id().catch(() => undefined)
  const account = sessionAccount(await getAccounts($), sessionId)
  if (account === undefined) {
    // 账号还没加载完（会话刚开始时扫描尚未跑到 loadAccounts）：只放进本会话状态，
    // 不落到 $.store，免得在兜底键下留一份永远不会被读的旧读数
    await setLimits($, cur => ({ ...cur, current: { at, windows } }))
    return
  }
  const stored = ((await $.store.get(LIMITS_STORE_KEY)) ?? {}) as Record<string, RateSnapshot>
  const { current: _stale, ...rest } = stored
  // 同一份读数若还挂在别的账号下（以前认错账号时存的），一并清掉
  const next = { ...dropMisfiledLimits(rest, account, windows), [account]: { at, windows } }
  await $.store.set(LIMITS_STORE_KEY, next)
  await setLimits($, cur => {
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
  if (refreshing || (await getBusy($))) {
    if (detail === 'full') pendingFull = true
    return
  }
  refreshing = true
  if (detail === 'full') pendingFull = false
  await setBusy($, () => true)
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
    await setSnapshot($, () => next)
    await saveLimits(
      $,
      usage.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
      next.at,
    )
  } catch (err) {
    $.ui.log(`${PLUGIN}: 刷新失败 ${String(err)}`)
  } finally {
    refreshing = false
    await setBusy($, () => false)
    if (pendingFull) {
      pendingFull = false
      void refresh($, 'full')
    }
  }
}

// ---------- 注册 ----------

export const register: Register = on => {
  /**
   * /ctx 是面板唯一的入口（命令在 startInsights 里注册）：
   * 打开「上下文洞察」总览，并增量扫描日志；
   * `/ctx full`：直接进入当前会话的上下文并做一次精确统计。
   */
  // 匹配器用字面量，校验器才能静态看出它对应哪个命令
  on('command.run', { command: 'ctx' }, async ($, e) => {
    // /ctx close：关闭面板（Desktop 标签上的 × 关不掉插件面板时用）
    if (e.args.trim() === 'close') {
      await $.ui.close({ id: PANE }).catch(() => undefined)
      return { text: '已关闭上下文洞察。', isTextDisplayOnly: true }
    }
    const isFull = e.args.trim() === 'full'
    const currentId = isFull ? await $.session.id().catch(() => null) : null
    await setFocus($, () => currentId)
    // 请求的默认宽度：恰好能把两个账号的额度并排放下（PANE_COLUMNS）。
    // 只是请求：用户拖过的宽度优先，宿主最多给窗口的 45%
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true, columns: PANE_COLUMNS }).catch(() => undefined)
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
    void $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
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
      await setSteps($, list => [...list, rec].slice(-MAX_STEPS))
      await setStepTotals($, t => ({
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
      await setTurns($, n => n + 1)
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
    await setActivity($, a => {
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

  // 「上下文洞察」面板：默认总览；`/ctx full` 进入当前会话的上下文（匹配器用字面量供校验器静态识别）
  on('ui.render', { component: 'Pane', requestId: 'cc-context-insights' }, async ($, e) => renderMain($, e))
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
          // 只有需要悬停提示的图才放进沙盒内嵌框；其余画成普通图片。
          // 内嵌框会抢滚轮事件、各自重排，列表里一多（会话圆环、额度条）滚动就会严重抖动
          isInteractive={p.isInteractive === true ? true : undefined}
        />
      )
    }
    const snap = await getSnapshot($)
    const list = await getSteps($)
    const turnCount = await getTurns($)
    const act = await getActivity($)
    const isBusy = await getBusy($)
    const agents = await $.agent.list().catch(() => [])
    const now = await $.clock.now()
    const allLimits = await getLimits($)
    const myAccount = sessionAccount(await getAccounts($), await $.session.id().catch(() => undefined))
    // 账号加载前的读数暂记在 'current' 下（只在本会话状态里）
    const mine = myAccount !== undefined ? allLimits[myAccount] : undefined
    const early = allLimits.current
    const myLimits = mine && early ? (early.at > mine.at ? early : mine) : (mine ?? early)
    const cols = e.props.bodyColumns
    const { full } = paneWidths(cols)
    const scan = await getScan($)
    const view = await getView($)
    const tzMin = scan.tzMin ?? -new Date().getTimezoneOffset()
    const setView = (fn: (v: InsightView) => InsightView) => void setViewState($, fn)

    // ----- 数据 -----
    const sum = await getStepTotals($)
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
    const drops = detectContextDrops(list)
    const fileFilter: FileFilter = view.fileFilter ?? 'all'
    const allFileEntries = Object.entries(act.files)
    const readFileCount = allFileEntries.filter(([, f]) => f.r > 0).length
    const writeFileCount = allFileEntries.filter(([, f]) => f.w > 0).length
    const filteredFiles = filterFiles(act.files, fileFilter)
    const FILES_VISIBLE = 6
    const FILES_MAX = 30
    const shownFiles = view.showAllFiles ? filteredFiles.slice(0, FILES_MAX) : filteredFiles.slice(0, FILES_VISIBLE)
    const fileFilters: [FileFilter, string][] = [
      ['all', `全部 ${allFileEntries.length}`],
      ['read', `读 ${readFileCount}`],
      ['write', `写 ${writeFileCount}`],
    ]
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

        {/* 上下文事件（骤降明细） */}
        {drops.length > 0 ? (
          <Section
            title="上下文事件"
            note={`压缩或清空 · 共 ${drops.length} 次${drops.length > 10 ? '（显示最近 10 次）' : ''}`}
          >
            <Box flexDirection="column" gap={1}>
              {drops
                .slice(-10)
                .reverse()
                .map(ev => (
                  <Box key={`sdrop-${ev.step}-${ev.at}`} flexDirection="row" justifyContent="space-between" columnGap={2}>
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
            {allFileEntries.length > 0 ? (
              <Box flexDirection="column" gap={1}>
                <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={2}>
                  <Text dimColor size="footnote">
                    文件活动
                  </Text>
                  <Box flexDirection="row" columnGap={1}>
                    {fileFilters.map(([fk, label]) => (
                      <Button
                        key={`sfile-filter-${fk}`}
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
                    {shownFiles.map(([p, f]) =>
                      row(
                        `file-${p}`,
                        <Text wrap="truncate-start">{shortFilePath(p)}</Text>,
                        [f.r > 0 ? `读 ${f.r}` : '', f.w > 0 ? `写 ${f.w}` : ''].filter(Boolean).join(' · '),
                      ),
                    )}
                  </Box>
                )}
                {filteredFiles.length > FILES_VISIBLE ? (
                  <Button
                    key="sfile-more"
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
