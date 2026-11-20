import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'cc-context-insights',
  component: 'Pane',
  requestId: 'cc-context-insights',
  props: {
    title: '上下文',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const USAGE = {
  startedAt: 0,
  rateLimits: [],
  cost: { usd: 0.42 },
  context: {
    tokens: 50_000,
    window: 200_000,
    percent: 25,
    breakdown: {
      categories: [
        { name: 'System prompt', tokens: 8000, color: 'promptBorder', isDeferred: false, kind: 'used' },
        { name: 'Messages', tokens: 42000, color: 'claude', isDeferred: false, kind: 'used' },
        { name: 'Free space', tokens: 117000, color: 'inactive', isDeferred: false, kind: 'free' },
        { name: 'Autocompact buffer', tokens: 33000, color: 'inactive', isDeferred: false, kind: 'buffer' },
      ],
      totalTokens: 50000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      autocompactSource: 'model-default',
      percentage: 25,
      gridRows: [],
      model: 'claude-opus-5-5',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      autoCompactThreshold: 167000,
      isAutoCompactEnabled: true,
      apiUsage: null,
    },
  },
}

test('面板在四种绘制端都能画出组成、成本、额度和命令统计', async ($, on) => {
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('command.register', () => ({ value: { command: 'ctx-insights' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({
    value: {
      ...USAGE,
      rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: new Date(1000 + 2 * 3600_000).toISOString() }],
    },
  }))
  on('agent.list', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  on('session.id', () => ({ value: 'cur' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'cd /tmp && git status' })
  await $.tool.call({ tool: 'Bash', command: 'FOO=1 /usr/bin/npm test' })
  // 面板默认是洞察总览；/ctx-insights full 直接进入当前会话的上下文
  await $.command.run({ command: 'ctx-insights', args: 'full' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Button', text: /返回洞察/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /System prompt/ }))?.text).toContain('System prompt')
    expect((await ui.find({ type: 'Text', text: /^\$0\.420$/ }))?.text).toBe('$0.420')
    expect((await ui.find({ type: 'Text', text: /^已使用 25%$/ }))?.text).toBe('已使用 25%')
    expect((await ui.find({ type: 'Text', text: /^50k \/ 200k$/ }))?.text).toBe('50k / 200k')
    // 三列图例：占比按窗口算（42k / 200k）
    expect((await ui.find({ type: 'Text', text: /^21\.0%$/ }))?.text).toBe('21.0%')
    expect((await ui.find({ type: 'Text', text: /命令：/ }))?.text).toContain('git×1')
    expect((await ui.find({ type: 'Text', text: /命令：/ }))?.text).toContain('npm×1')
    // 订阅额度一行：读数来自本轮结束时存下的快照
    expect((await ui.find({ type: 'Text', text: /^42%$/ }))?.text).toBe('42%')
    expect((await ui.find({ type: 'Text', text: /2 小时后重置/ }))?.text).toContain('2 小时后重置')
    await ui.unmount()
  }
  // 快照按账号存进了跨会话的 $.store
  expect(Object.keys((store.get('limits-1') ?? {}) as object)).toEqual(['current'])
})

test('面板默认是洞察总览，没有顶部标签；返回按钮从会话回到总览', async ($, on) => {
  on('agent.list', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('session.usage', () => ({ value: { ...USAGE, rateLimits: [] } }))
  on('session.id', () => ({ value: 'cur' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', text: /^本会话$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /^7 天$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /返回洞察/ })).toBeUndefined()
  // 进入当前会话，再返回
  await $.command.run({ command: 'ctx-insights', args: 'full' })
  expect((await ui.find({ type: 'Text', text: /^已使用/ }))?.text).toContain('已使用')
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /^已使用/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /^7 天$/ })).toBeDefined()
  await ui.unmount()
})

test('没有数据时给出提示', async ($, on) => {
  on('agent.list', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('session.id', () => ({ value: 'cur' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  await $.command.run({ command: 'ctx-insights', args: 'full' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /发一条消息后自动统计/ }))?.text).toContain('自动统计')
  await ui.unmount()
})
