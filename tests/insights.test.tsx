import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'cc-context-insights',
  component: 'Pane',
  // 洞察已并入「上下文」面板；/ctx-insights 会把它切到「洞察」标签页
  requestId: 'cc-context-insights',
  props: {
    title: '上下文',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const NOW = Date.parse('2026-11-20T04:00:00Z')
const TS = '2026-11-20T03:00:00.000Z'
const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 }
const asst = (req: string, block: object) =>
  JSON.stringify({
    parentUuid: 'p',
    requestId: req,
    type: 'assistant',
    timestamp: TS,
    cwd: '/Users/me/Developer/crm-ext',
    message: { model: 'claude-opus-5-5', id: 'm-' + req, content: [block], usage },
  })

// 一次请求拆成三行（usage 相同），只能计一次
const LOG = [
  '{"type":"custom-title","customTitle":"测试会话标题","sessionId":"s1"}',
  JSON.stringify({ type: 'user', timestamp: TS, turnOrigin: 'human', cwd: '/Users/me/Developer/crm-ext', message: { content: 'hi' } }),
  asst('r1', { type: 'thinking', thinking: '' }),
  asst('r1', { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cd x && git status' } }),
  asst('r1', { type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'tdd' } }),
  asst('r2', { type: 'text', text: 'ok' }),
  JSON.stringify({ type: 'user', timestamp: TS, message: { content: [{ type: 'tool_result', content: '"type":"assistant"' }] } }),
  '{"type":"cost-state","sessionId":"s1","totalCostUSD":1.5}',
  '', // 末尾换行
].join('\n')

const SIZE = new TextEncoder().encode(LOG).length

// 进行中的会话：还没有 cost-state，应按 s1 学到的单价估算并标「≈」
const LOG2 = [
  '{"type":"custom-title","customTitle":"进行中的会话","sessionId":"s2"}',
  asst('r9', { type: 'text', text: 'hi' }),
  '',
].join('\n')
const SIZE2 = new TextEncoder().encode(LOG2).length

test('扫描日志：按 requestId 去重、统计工具/技能/命令/提问/成本，并画出面板', async ($, on) => {
  const store = new Map<string, unknown>()
  on('clock.now', () => ({ value: NOW }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('fs.list', (_, e) => {
    if (e.path === '/h/.claude/projects') return { value: [{ name: '-Users-me-crm', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    const desk = '/h/Library/Application Support/Claude/claude-code-sessions'
    if (e.path === desk)
      return {
        value: [
          { name: 'acctA', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
          { name: 'acctB', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
        ],
      }
    if (e.path === `${desk}/acctA`) return { value: [{ name: 'orgX', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    if (e.path === `${desk}/acctA/orgX`)
      return { value: [{ name: 'local_1.json', kind: 'file', size: 40, mtimeMs: 0, isLink: false }] }
    if (e.path === '/h/.claude/projects/-Users-me-crm')
      return {
        value: [
          { name: 's1.jsonl', kind: 'file', size: SIZE, mtimeMs: 0, isLink: false },
          { name: 's2.jsonl', kind: 'file', size: SIZE2, mtimeMs: 0, isLink: false },
        ],
      }
    return { value: [] }
  })
  on('fs.read', (_, e) => {
    if (e.path.endsWith('local_1.json')) return { value: '{"cliSessionId":"s9","priorCliSessionIds":["s1"]}' }
    if (e.path === '/h/.claude/cc-context-insights/accounts.json') return { value: '{"acctB":"b@y.com"}' }
    if (e.path === '/h/.claude.json') return { value: '{"oauthAccount":{"accountUuid":"acctA","emailAddress":"a@x.com"}}' }
    const text = e.path.endsWith('s2.jsonl') ? LOG2 : LOG
    const bytes = new TextEncoder().encode(text).subarray(e.offset ?? 0, (e.offset ?? 0) + (e.length ?? SIZE))
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return { value: { base64: btoa(bin) } }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [{ kind: 'five_hour', percentUsed: 87, resetsAt: new Date(NOW + 90 * 60_000).toISOString() }],
      context: { window: 200000 },
    },
  }))
  on('agent.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'cur' }))
  on('fs.stat', (_, e) => ({
    value: { kind: 'file', size: e.path.endsWith('s2.jsonl') ? SIZE2 : SIZE, mtimeMs: 0, isLink: false },
  }))

  await $.command.run({ command: 'ctx-insights', args: '' })
  // 等后台扫描跑完
  for (let i = 0; i < 5000 && store.size === 0; i++) await new Promise<void>(r => r())
  for (let i = 0; i < 2000; i++) await new Promise<void>(r => r())

  const agg = store.get('agg3:/h/.claude/projects/-Users-me-crm/s1.jsonl') as Record<string, unknown>
  // 计费权重：每次请求 10 + 200×1.25 + 1000×0.1 + 50×5 = 610，两次 1220；cost-state 在最后
  expect(agg.weight).toBe(1220)
  expect(agg.costAtWeight).toBe(1220)
  expect(agg).toBeDefined()
  type Day = { req: number; prompts: number; cr: number; tools: Record<string, number>; skills: Record<string, number>; programs: Record<string, number>; models: Record<string, number>; hours: Record<string, number> }
  const days = agg.days as Record<string, Day>
  const day = Object.values(days)[0]
  expect(day?.req).toBe(2) // r1 三行只算一次 + r2
  expect(day?.prompts).toBe(1) // tool_result 不是提问
  expect(day?.cr).toBe(2000)
  expect(agg.costUsd).toBe(1.5)
  expect(agg.title).toBe('测试会话标题')
  expect(day?.tools.Bash).toBe(1)
  expect(day?.skills.tdd).toBe(1)
  expect(day?.programs.git).toBe(1)
  expect(day?.models['claude-opus-5-5']).toBe(2)
  expect(Object.values(day?.hours ?? {}).reduce((a, b) => a + b, 0)).toBe(2) // 两次请求落在同一小时
  expect(agg.offset).toBe(SIZE)
  expect((store.get('account-labels-1') as Record<string, { email?: string }>).acctA?.email).toBe('a@x.com')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /测试会话标题/ }))?.text).toContain('测试会话标题')
    expect((await ui.find({ type: 'Text', text: /1 次提问$/ }))?.text).toContain('crm-ext')
    expect((await ui.find({ type: 'Text', text: /^\$1\.50$/ }))?.text).toBe('$1.50')
    // 进行中的会话：610 × (1.5 / 1220) = $0.75，标「≈」
    expect((await ui.find({ type: 'Text', text: /^≈ \$0\.750$/ }))?.text).toBe('≈ $0.750')
    // 订阅额度放在最上面，超过 80% 的读数可见
    expect((await ui.find({ type: 'Text', text: /^87%$/ }))?.text).toBe('87%')
    expect((await ui.find({ type: 'Text', text: /1 小时 30 分后重置/ }))?.text).toContain('后重置')
    expect((await ui.find({ type: 'Text', text: /等价 API 成本/ }))?.text).toContain('等价 API 成本')
    // 桌面端每张图都显式带高度（否则内嵌框默认 150px：高图被截、矮图留白）
    if (surface === 'desktop') {
      const svgs = await ui.findAll({ type: 'Svg' })
      expect(svgs.length).toBeGreaterThan(2)
      expect(svgs.every(s => typeof s.props.height === 'number' && (s.props.height as number) > 0)).toBe(true)
      // 每日成本图：内容 180 高，框高留了余量，不会被裁
      expect(svgs.some(s => (s.props.height as number) >= 180 && (s.props.height as number) <= 200)).toBe(true)
      // 「更多」里的排行：框高固定为可见行数，内容可更高（在框内滑动）
      await ui.press({ key: 'toggle-activity' })
      const ranks = (await ui.findAll({ type: 'Svg' })).filter(s => s.props.alt === '排行')
      expect(ranks.length).toBeGreaterThan(0)
      expect(ranks.every(s => (s.props.height as number) <= 26 * 6 + 6)).toBe(true)
      await ui.press({ key: 'toggle-activity' })
    }
    // 账号下拉里有当前账号
    const select = await ui.find({ type: 'Select' })
    const options = (select?.props.options ?? []) as { label?: string }[]
    expect(options.some(o => o.label === 'a@x.com（当前）')).toBe(true)
    // 活动明细默认折叠，展开后才有技能排行
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /^tdd$/ })).toBeUndefined()
      await ui.press({ key: 'toggle-activity' })
      expect((await ui.find({ type: 'Text', text: /^tdd$/ }))?.text).toBe('tdd')
      await ui.press({ key: 'toggle-activity' })
    }
    await ui.unmount()
  }

  // 双击会话：单击不进入；双击进入它的上下文（非当前会话，从日志还原）；返回回到总览
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-s2' })
  expect(await ui.find({ type: 'Button', text: /返回洞察/ })).toBeUndefined()
  await ui.press({ key: 'open-s2' })
  for (let i = 0; i < 2000; i++) await new Promise<void>(r => r())
  expect(await ui.find({ type: 'Button', text: /返回洞察/ })).toBeDefined()
  // s2 只有一次请求：上下文 10 + 1000 + 200 = 1210，按 200k 窗口约 0.6%
  expect((await ui.find({ type: 'Text', text: /^最后上下文/ }))?.text).toBe('最后上下文 0.6%')
  expect((await ui.find({ type: 'Text', text: /^进行中的会话$/ }))?.text).toBe('进行中的会话')
  expect((await ui.find({ type: 'Text', text: /1 次请求/ }))?.text).toContain('骤降')
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Button', text: /返回洞察/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /测试会话标题/ }))?.text).toContain('测试会话标题')
  await ui.unmount()
})
