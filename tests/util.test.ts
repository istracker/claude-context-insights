import { expect, test } from 'claude-code/testing'

import { contextTrendSvg, dailySvg, svgSize } from '../hooks/charts'
import { mergeSessions, rankIndex, toolKey } from '../hooks/insights'
import { emptyAgg, loadAccounts } from '../hooks/scan'
import {
  dropMisfiledLimits,
  fmtDayAgo,
  fmtTokens,
  fmtUntil,
  paneWidths,
  programOf,
  sameAccountWindows,
  sessionAccount,
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
      models: { m: 1 }, tools: {}, skills: {}, programs: {}, hours: {},
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
    [`${desk}/acctA/org/local_1.json`]: '{"cliSessionId":"desk-session"}',
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
  // 本会话还没被桌面端记录（如纯 CLI 会话）：退回 ~/.claude.json
  expect((await loadAccounts($, '/h', 'unknown')).current).toBe('acctB')
  expect((await loadAccounts($, '/h')).current).toBe('acctB')
})

test('额度串号：按会话归属取账号；重置时间一致的旧读数视为存错账号并清掉', () => {
  const acc = { bySession: { s1: 'acctA' }, labels: {}, current: 'acctB' }
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

test('排行：次数、最近日期、用过它的会话；未估价项目不计入项目排行；MCP 工具按服务合并', () => {
  const [a, b] = mergeSessions([session('a', { weight: 100, costUsd: 1 }), session('b', { weight: 50, costUsd: 0.5 })])
  const [unpriced] = mergeSessions([session('u', { weight: 50 })])
  if (!a || !b || !unpriced) throw new Error('缺少会话')
  a.days['2026-11-19'] = { ...a.days['2026-11-20']!, tools: { Bash: 2 }, programs: { git: 2 } }
  a.days['2026-11-20']!.tools = { Bash: 1, mcp__srv__x: 1, mcp__srv__y: 2 }
  b.days['2026-11-20']!.tools = { Bash: 1 }
  const r = rankIndex([a, b, unpriced], undefined, false)
  expect(r.tool.get('Bash')?.value).toBe(4)
  expect([...(r.tool.get('Bash')?.ids ?? [])].sort()).toEqual(['a', 'b'])
  expect(r.tool.get('Bash')?.lastDay).toBe('2026-11-20')
  expect(r.prog.get('git')?.lastDay).toBe('2026-11-19')
  expect(r.tool.get('srv（MCP）')?.value).toBe(3)
  expect([...(r.prog.get('git')?.ids ?? [])]).toEqual(['a'])
  // 未估价会话（dayUsd = 0）不进项目排行，避免抬头项目数与列表不一致
  expect(r.proj.get('未知项目')?.ids.has('u')).toBe(false)
  // 不在范围内的天不计
  expect(rankIndex([a, b], new Set(['2026-11-18']), false).tool.size).toBe(0)
  expect(toolKey('mcp__srv__x', true)).toBe('srv · x')
  expect(fmtDayAgo('2026-11-20', '2026-11-20')).toBe('今天')
  expect(fmtDayAgo('2026-11-19', '2026-11-20')).toBe('昨天')
  expect(fmtDayAgo('2026-11-15', '2026-11-20')).toBe('5 天前')
})
