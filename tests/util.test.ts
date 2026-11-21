import { expect, test } from 'claude-code/testing'

import { contextTrendSvg, dailySvg, svgSize } from '../hooks/charts'
import { groupByProject, mergeSessions, rankIndex, shellQuote, toolKey } from '../hooks/insights'
import { emptyAgg, loadAccounts } from '../hooks/scan'
import {
  billingWeight,
  cacheReadFactor,
  detectContextDrops,
  dropMisfiledLimits,
  filterFiles,
  fmtClockTime,
  fmtDayAgo,
  fmtTokens,
  fmtUntil,
  layoutTier,
  paneWidths,
  programOf,
  sameAccountWindows,
  sessionAccount,
  shortFilePath,
  fmtResetAt,
  prettyModel,
  quotaWindowName,
} from '../hooks/util'
import type { SessionAgg } from '../types'

test('programOf：跳过 sudo/env 等前缀、赋值、注释与子 shell 括号', () => {
  expect(programOf('sudo npm install')).toBe('npm')
  expect(programOf('sudo -u root npm install')).toBe('npm')
  expect(programOf('env NODE_ENV=prod node app.js')).toBe('node')
  expect(programOf('env -i PATH=/bin node app.js')).toBe('node')
  expect(programOf('FOO="a b" git status')).toBe('git')
  expect(programOf("FOO='a b c' git status")).toBe('git')
  expect(programOf('FOO="ab" git status')).toBe('git')
  expect(programOf('(cd x && git status)')).toBe('git')
  expect(programOf('# 先看状态\ngit status')).toBe('git')
  expect(programOf('cd x && /usr/bin/make build')).toBe('make')
  expect(programOf('cd x')).toBe(undefined)
})

test('fmtTokens / fmtUntil：负数与非法值', () => {
  expect(fmtTokens(-120_000)).toBe('-120k')
  expect(fmtTokens(-1500)).toBe('-1.5k')
  expect(fmtTokens(NaN)).toBe('—')
  expect(fmtUntil(NaN)).toBe('—')
  expect(fmtUntil(2 * 3_600_000)).toBe('2 小时')
})

function session(id: string, opts: { weight: number; costUsd?: number; isSub?: boolean }): SessionAgg {
  const a = emptyAgg(id, `/p/${id}${opts.isSub ? '/subagents/a' : ''}.jsonl`, opts.isSub ?? false)
  a.weight = opts.weight
  if (opts.costUsd !== undefined) {
    a.costUsd = opts.costUsd
    a.costAtWeight = opts.weight
  }
  a.lastAt = 1
  a.days = {
    '2026-11-20': {
      in: opts.weight, out: 0, cr: 0, cw: 0, cw1h: 0, req: 1, prompts: 1,
      models: { m: 1 }, modelWeight: { m: opts.weight }, tools: {}, toolTokens: {},
    },
  }
  return a
}

test('单价学习：带子 Agent 的会话不抬高单价', () => {
  const out = mergeSessions([
    // 干净样本：1 美元 / 100 权重
    session('clean', { weight: 100, costUsd: 1 }),
    // 含子 Agent：成本包含子 Agent，若只按主会话权重学会得出 3 美元 / 100
    session('mixed', { weight: 100, costUsd: 3 }),
    session('mixed', { weight: 200, isSub: true }),
    // 进行中的会话：按学到的单价估价
    session('live', { weight: 100 }),
  ])
  const live = out.find(s => s.id === 'live')
  expect(Math.round((live?.costUsd ?? 0) * 1e6) / 1e6).toBe(1)
  expect(live?.isEstimated).toBe(true)
})

test('单价学习：只有带子 Agent 的样本时，分母计入子 Agent 权重', () => {
  const out = mergeSessions([
    session('mixed', { weight: 100, costUsd: 3 }),
    session('mixed', { weight: 200, isSub: true }),
    session('live', { weight: 100 }),
  ])
  expect(Math.round((out.find(s => s.id === 'live')?.costUsd ?? 0) * 1e6) / 1e6).toBe(1)
})

test('当前账号：桌面端登录的账号与 CLI（~/.claude.json）不同时，以本会话所在账号为准', async () => {
  const desk = '/h/Library/Application Support/Claude/claude-code-sessions'
  const dir = (name: string) => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
  const files: Record<string, string> = {
    [`${desk}/acctA/org/local_1.json`]: '{"cliSessionId":"desk-session","priorCliSessionIds":["old-session"],"title":"侧边栏标题","isArchived":true}',
    [`${desk}/acctB/org/local_1.json`]: '{"cliSessionId":"cli-session"}',
    // CLI 登录的是 B
    '/h/.claude.json': '{"oauthAccount":{"accountUuid":"acctB","emailAddress":"b@x.com"}}',
  }
  // loadAccounts 只用到 fs.list / fs.read / store.get / store.set
  const $ = {
    fs: {
      list: async (path: string) => {
        if (path === desk) return [dir('acctA'), dir('acctB')]
        if (path === `${desk}/acctA` || path === `${desk}/acctB`) return [dir('org')]
        if (path.endsWith('/org')) return [{ name: 'local_1.json', kind: 'file', size: 40, mtimeMs: 0, isLink: false }]
        return []
      },
      read: async (path: string) => files[path] ?? '',
    },
    store: { get: async () => undefined, set: async () => undefined },
  } as unknown as Parameters<typeof loadAccounts>[0]

  // 本会话记在 A 下：当前账号是 A；B 的邮箱照样记下
  const a = await loadAccounts($, '/h', 'desk-session')
  expect(a.current).toBe('acctA')
  expect(a.labels.acctB?.email).toBe('b@x.com')
  // CLI 会话 id → Desktop 会话 id（取自文件里的 sessionId，缺失时用文件名）
  expect(a.desktopBySession['desk-session']).toBe('local_1')
  expect(a.desktopBySession['cli-session']).toBe('local_1')
  // Desktop 标题与归档状态只记在当前日志 id 上；回退前的旧 id 保留它自己的标题
  expect(a.desktopMeta?.['desk-session']).toEqual({ title: '侧边栏标题', isArchived: true })
  expect(a.desktopMeta?.['old-session']).toBeUndefined()
  expect(a.bySession['old-session']).toBe('acctA')
  // 本会话还没被桌面端记录（如纯 CLI 会话）：退回 ~/.claude.json
  expect((await loadAccounts($, '/h', 'unknown')).current).toBe('acctB')
  expect((await loadAccounts($, '/h')).current).toBe('acctB')
})

test('额度串号：按会话归属取账号；重置时间一致的旧读数视为存错账号并清掉', () => {
  const acc = { bySession: { s1: 'acctA' }, desktopBySession: {}, labels: {}, current: 'acctB' }
  // 状态里的 current 过期了，会话归属优先
  expect(sessionAccount(acc, 's1')).toBe('acctA')
  expect(sessionAccount(acc, 'other')).toBe('acctB')
  expect(sessionAccount(acc, undefined)).toBe('acctB')

  const w = (p5: number, r5: string, r7: string) => [
    { kind: 'five_hour', percentUsed: p5, resetsAt: r5 },
    { kind: 'seven_day', percentUsed: 2, resetsAt: r7 },
  ]
  const live = w(13, '2026-11-20T14:00:00.000Z', '2026-11-25T08:00:00.000Z')
  // B 名下的旧读数与 A 的实时读数重置时间一致（百分比旧一点）：同一账号
  expect(sameAccountWindows(w(12, '2026-11-20T14:00:00.000Z', '2026-11-25T08:00:00.000Z'), live)).toBe(true)
  // 只有一个窗口对上：不足以判断
  expect(sameAccountWindows(w(12, '2026-11-20T14:00:00.000Z', '2026-11-26T08:00:00.000Z'), live)).toBe(false)
  expect(sameAccountWindows([live[0]!], [live[0]!])).toBe(false)

  const stored = {
    acctB: { at: 1, windows: w(12, '2026-11-20T14:00:00.000Z', '2026-11-25T08:00:00.000Z') },
    acctC: { at: 1, windows: w(50, '2026-11-20T16:00:00.000Z', '2026-11-22T08:00:00.000Z') },
  }
  expect(Object.keys(dropMisfiledLimits(stored, 'acctA', live)).sort()).toEqual(['acctC'])
})

test('paneWidths 与图表下限一致：窄面板与双栏临界点不溢宽', () => {
  const narrow = paneWidths(40)
  expect(narrow.full).toBe(240)
  expect(svgSize(dailySvg([{ day: '2026-11-20', usd: 1, tokens: 100, req: 1, prompts: 1 }], narrow.full)).width).toBe(narrow.full)
  expect(svgSize(contextTrendSvg([1000, 2000], 200_000, undefined, narrow.full)).width).toBe(narrow.full)
  // 70 列放不下两张 200px 卡片，half 退回 full；74 列起才并排两栏
  expect(paneWidths(70).half).toBe(paneWidths(70).full)
  expect(paneWidths(74).half).toBeGreaterThanOrEqual(200)
})

test('排行：模型按成本、工具按上下文估算 token（副计数保留次数）', () => {
  const [a, b] = mergeSessions([session('a', { weight: 100, costUsd: 1 }), session('b', { weight: 50, costUsd: 0.5 })])
  const [unpriced] = mergeSessions([session('u', { weight: 50 })])
  if (!a || !b || !unpriced) throw new Error('缺少会话')
  a.days['2026-11-19'] = {
    ...a.days['2026-11-20']!,
    models: { opus: 1, haiku: 4 },
    modelWeight: { opus: 80, haiku: 20 },
    tools: { Bash: 2 },
    toolTokens: { Bash: 500 },
  }
  a.dayUsd['2026-11-19'] = 0.5
  a.days['2026-11-20']!.tools = { Bash: 1, mcp__srv__x: 1, mcp__srv__y: 2 }
  a.days['2026-11-20']!.toolTokens = { Bash: 300, mcp__srv__x: 1200, mcp__srv__y: 2800 }
  b.days['2026-11-20']!.tools = { Bash: 1 }
  b.days['2026-11-20']!.toolTokens = { Bash: 200 }
  const r = rankIndex([a, b, unpriced], undefined, false)
  // 工具按估算 token 排：srv（MCP）= 4000 token（3 次），Bash = 1000 token（4 次）
  expect(r.tool.get('srv（MCP）')?.value).toBe(4000)
  expect(r.tool.get('srv（MCP）')?.subCount).toBe(3)
  expect(r.tool.get('Bash')?.value).toBe(1000)
  expect(r.tool.get('Bash')?.subCount).toBe(4)
  expect([...(r.tool.get('Bash')?.ids ?? [])].sort()).toEqual(['a', 'b'])
  expect(r.tool.get('Bash')?.lastDay).toBe('2026-11-20')
  // 模型按成本排：11-19 当天成本 $0.5，opus 权重占 80%（$0.4）高于 haiku（$0.1，尽管 haiku 请求数 4 > 1）
  expect((r.model.get('opus')?.value ?? 0) > (r.model.get('haiku')?.value ?? 0)).toBe(true)
  expect(r.model.get('haiku')?.subCount).toBe(4)
  // 不在范围内的天不计
  expect(rankIndex([a, b], new Set(['2026-11-18']), false).tool.size).toBe(0)
  expect(toolKey('mcp__srv__x', true)).toBe('srv · x')
  expect(fmtDayAgo('2026-11-20', '2026-11-20')).toBe('今天')
  expect(fmtDayAgo('2026-11-19', '2026-11-20')).toBe('昨天')
  expect(fmtDayAgo('2026-11-15', '2026-11-20')).toBe('5 天前')
})

test('会话按项目分组：组内保持顺序，组序跟随排序方式', () => {
  const mk = (id: string, project: string, usd: number, lastAt: number, ctx?: number) => ({
    id,
    project,
    lastAt,
    // token 取成本的 100 倍，c 例外：成本最高但 token 最少
    r: { usd, in: project === 'c' ? 1 : usd * 100, out: 0, cr: 0, cw: 0 },
    ctx,
  })
  const list = [mk('1', 'b', 1, 50, 150_000), mk('2', 'a', 5, 40), mk('3', 'b', 2, 30), mk('4', 'c', 10, 10, 20_000)]
  // 按时间：看组内最近活动（b=50 > a=40 > c=10），组内保持传入顺序
  const byTime = groupByProject(list, 'recent')
  expect(byTime.map(g => g.name)).toEqual(['b', 'a', 'c'])
  expect(byTime[0]?.sessions.map(s => s.id)).toEqual(['1', '3'])
  expect(byTime[0]?.usd).toBe(3)
  // 按成本：看项目总成本（c=10 > a=5 > b=3）
  expect(groupByProject(list, 'cost').map(g => g.name)).toEqual(['c', 'a', 'b'])
  // 按 token：看项目总 token（a=500 > b=300 > c=1）
  expect(groupByProject(list, 'tokens').map(g => g.name)).toEqual(['a', 'b', 'c'])
  // 按当前上下文：看组内最高占比（b=75% > c=10% > a 无数据）
  expect(groupByProject(list, 'context').map(g => g.name)).toEqual(['b', 'c', 'a'])
})

test('上下文骤降事件、文件活动筛选与路径截短', () => {
  const t0 = Date.parse('2026-11-20T06:30:00Z')
  const drops = detectContextDrops([
    { at: t0, ctx: 40_000 },
    { at: t0 + 60_000, ctx: 10_000 }, // 前一步 <=50k 不计
    { at: t0 + 120_000, ctx: 160_000 },
    { at: t0 + 180_000, ctx: 40_000 }, // 160k -> 40k（<60%）计为第 4 步骤降
    { at: t0 + 240_000, ctx: 120_000 },
    { at: t0 + 300_000, ctx: 100_000 }, // 下降不足 40% 不计
  ])
  expect(drops).toEqual([{ step: 4, at: t0 + 180_000, from: 160_000, to: 40_000 }])
  // UTC 06:33 + 480min（北京）= 14:33
  expect(fmtClockTime(t0 + 180_000, 480)).toBe('14:33')

  const files = {
    '/a/b/read-only.ts': { r: 4, w: 0 },
    '/a/b/write-heavy.ts': { r: 1, w: 5 },
    '/a/b/write-only.ts': { r: 0, w: 2 },
  }
  expect(filterFiles(files, 'all').map(([p]) => p)).toEqual(['/a/b/write-heavy.ts', '/a/b/read-only.ts', '/a/b/write-only.ts'])
  expect(filterFiles(files, 'read').map(([p]) => p)).toEqual(['/a/b/read-only.ts', '/a/b/write-heavy.ts'])
  expect(filterFiles(files, 'write').map(([p]) => p)).toEqual(['/a/b/write-heavy.ts', '/a/b/write-only.ts'])
  expect(shortFilePath('/Users/me/proj/src/index.ts')).toBe('src/index.ts')
  expect(shortFilePath('C:\\Users\\me\\proj\\src\\index.ts')).toBe('src/index.ts')
})

test('按模型计费权重：Opus/Sonnet 5.5 缓存读 0.05×，4.x/Haiku 0.1×，Fable 0.025×，cw1h>cw 不出负值', () => {
  expect(cacheReadFactor('claude-opus-5-5')).toBe(0.05)
  expect(cacheReadFactor('claude-sonnet-5-5-20261001')).toBe(0.05)
  expect(cacheReadFactor('claude-fable-5-2')).toBe(0.025)
  expect(cacheReadFactor('claude-haiku-5-5')).toBe(0.1)
  expect(cacheReadFactor('claude-opus-4-6')).toBe(0.1)
  expect(cacheReadFactor(undefined)).toBe(0.1)

  // Opus 5.5: 10 + 200*1.25 + 1000*0.05 + 50*5 = 560
  expect(billingWeight(10, 50, 1000, 200, 0, 'claude-opus-5-5')).toBe(560)
  // Haiku 5.5: 10 + 200*1.25 + 1000*0.1 + 50*5 = 610
  expect(billingWeight(10, 50, 1000, 200, 0, 'claude-haiku-5-5')).toBe(610)
  // 异常数据 cw1h > cw 时不把 5m 写算成负数
  expect(billingWeight(0, 0, 0, 10, 20, 'claude-opus-5-5')).toBe(40)
})

test('layoutTier：60 / 84 列为窄、中、宽的分界', () => {
  expect(layoutTier(40)).toBe('narrow')
  expect(layoutTier(59)).toBe('narrow')
  expect(layoutTier(60)).toBe('medium')
  expect(layoutTier(83)).toBe('medium')
  expect(layoutTier(84)).toBe('wide')
  expect(layoutTier(120)).toBe('wide')
})

test('额度重置时刻：当天只写时刻，一周内带星期，更远写日期', () => {
  const tz = 480
  const now = Date.parse('2026-11-21T02:00:00Z') // 北京时间 11-21（周六）10:00
  expect(fmtResetAt(Date.parse('2026-11-21T10:10:00Z'), now, tz)).toBe('18:10')
  expect(fmtResetAt(Date.parse('2026-11-23T13:00:00Z'), now, tz)).toBe('周一21:00')
  expect(fmtResetAt(Date.parse('2026-12-03T13:00:00Z'), now, tz)).toBe('12/3 21:00')
  expect(quotaWindowName('seven_day')).toBe('每周 · 所有模型')
})

test('模型友好名', () => {
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-fable-5-2')).toBe('Fable 5.2')
  expect(prettyModel('claude-sonnet-4-20250514')).toBe('Sonnet 4')
  expect(prettyModel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
  expect(prettyModel('unknown')).toBe('unknown')
})

test('shellQuote：普通路径原样，含空格或单引号的加引号转义', () => {
  expect(shellQuote('/Users/me/proj')).toBe('/Users/me/proj')
  expect(shellQuote('/Users/me/my proj')).toBe("'/Users/me/my proj'")
  expect(shellQuote("/tmp/it's")).toBe("'/tmp/it'\\''s'")
})
