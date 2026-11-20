import { expect, test } from 'claude-code/testing'

import { mergeSessions } from '../hooks/insights'
import { emptyAgg } from '../hooks/scan'
import { fmtTokens, fmtUntil, programOf } from '../hooks/util'
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
