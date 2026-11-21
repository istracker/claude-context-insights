import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'cc-context-insights',
  component: 'Pane',
  // 洞察已并入「上下文」面板；/ctx 会把它切到「洞察」标签页
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

test('扫描日志：按 requestId 去重、统计工具/命令/提问/成本，并画出面板', async ($, on) => {
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

  await $.command.run({ command: 'ctx', args: '' })
  // 等后台扫描跑完
  for (let i = 0; i < 5000 && store.size === 0; i++) await new Promise<void>(r => r())
  for (let i = 0; i < 2000; i++) await new Promise<void>(r => r())

  const agg = store.get('agg6:/h/.claude/projects/-Users-me-crm/s1.jsonl') as Record<string, unknown>
  // Opus 5.5 缓存读 0.05×：每次请求 10 + 200×1.25 + 1000×0.05 + 50×5 = 560，两次 1120；cost-state 在最后
  expect(agg.weight).toBe(1120)
  expect(agg.costAtWeight).toBe(1120)
  expect(agg).toBeDefined()
  type Day = {
    req: number
    prompts: number
    cr: number
    tools: Record<string, number>
    toolTokens?: Record<string, number>
    models: Record<string, number>
    modelWeight?: Record<string, number>
  }
  const days = agg.days as Record<string, Day>
  const day = Object.values(days)[0]
  expect(day?.req).toBe(2) // r1 三行只算一次 + r2
  expect(day?.prompts).toBe(1) // tool_result 不是提问
  expect(day?.cr).toBe(2000)
  expect(agg.costUsd).toBe(1.5)
  expect(agg.title).toBe('测试会话标题')
  expect(day?.tools.Bash).toBe(1)
  expect(day?.toolTokens?.Bash).toBeGreaterThan(0)
  expect(day?.models['claude-opus-5-5']).toBe(2)
  expect(day?.modelWeight?.['claude-opus-5-5']).toBe(1120)
  expect(agg.offset).toBe(SIZE)
  expect((store.get('account-labels-1') as Record<string, { email?: string }>).acctA?.email).toBe('a@x.com')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // 账号下拉在顶部工具栏，任何页签都有
    const select = await ui.find({ type: 'Select' })
    const options = (select?.props.options ?? []) as { label?: string }[]
    expect(options.some(o => o.label === 'a@x.com（当前）')).toBe(true)

    // ---- 总览页签：订阅额度 + 花费；不出现会话与工具 ----
    if (surface === 'terminal') {
      // 重置时间显示为具体时刻（与 Claude 自带用量界面一致）
      expect((await ui.find({ type: 'Text', text: /\d+:\d{2} 重置 $/ }))?.text).toMatch(/重置 $/)
      expect((await ui.find({ type: 'Text', text: /^5 小时限额$/ }))?.text).toBe('5 小时限额')
      expect((await ui.find({ type: 'Text', text: /^已用 87%$/ }))?.text).toBe('已用 87%')
    } else {
      // 桌面端整行画成一张图：窗口名、重置时刻与百分比都在图里
      const quota = (await ui.findAll({ type: 'Svg' })).find(x => String(x.props.alt).startsWith('5 小时限额'))
      expect(String(quota?.props.alt)).toMatch(/重置 已用 \d+%$/)
      expect((await ui.findAll({ type: 'Svg' })).some(x => String(x.props.alt).endsWith('已用 87%'))).toBe(true)
    }
    expect((await ui.find({ type: 'Text', text: /^用量$/ }))?.text).toBe('用量')
    expect((await ui.find({ type: 'Text', text: /按 API 标价折算/ }))?.text).toContain('不是账单')
    // 一整页：额度、用量、工具、会话都在同一页，没有页签
    expect(await ui.find({ type: 'Button', key: 'tab-sessions' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /测试会话标题/ }))?.text).toContain('测试会话标题')
    if (surface === 'desktop') {
      const svgs = await ui.findAll({ type: 'Svg' })
      // 每张图都显式带高度（否则内嵌框默认 150px）；宽度：铺满图不给（按 100% 铺满卡片），其余给数字
      expect(svgs.every(s => typeof s.props.height === 'number' && (s.props.height as number) > 0)).toBe(true)
      expect(
        svgs.every(s =>
          String(s.props.source).includes('data-fluid="1"') ? s.props.width === undefined : typeof s.props.width === 'number',
        ),
      ).toBe(true)
      // 用量卡片里的每日 token 柱图铺满宽度、100 高
      expect(svgs.some(s => String(s.props.alt).includes('每日 token') && s.props.height === 100 && s.props.width === undefined)).toBe(true)
      // 额度条画成普通图片，只有每日柱状图（要悬停明细）放进内嵌框
      const quotaBars = svgs.filter(s => String(s.props.alt).includes('重置'))
      expect(quotaBars.length).toBeGreaterThan(0)
      expect(quotaBars.every(s => s.props.isInteractive !== true)).toBe(true)
      expect(svgs.filter(s => s.props.isInteractive === true).map(s => String(s.props.alt))).toEqual([
        expect.stringContaining('每日 token'),
      ])
    }

    // 工具上下文卡已移除：工具怎么调用由模型决定，用户无从下手
    expect(await ui.find({ type: 'Text', text: /^工具上下文$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'pick-tool-Bash' })).toBeUndefined()

    // ---- 会话页签：以项目为主线，默认展开第一个项目 ----
    expect((await ui.find({ type: 'Text', text: /测试会话标题/ }))?.text).toContain('测试会话标题')
    expect((await ui.find({ type: 'Text', text: /^‹  crm-ext$/ }))?.text).toBe('‹  crm-ext')
    // 会话行里不再重复项目名
    // 第 2 行：账号 · token · 最后一条消息（不再有提问数、上下文百分比；会话行不显示金额）
    const meta = (await ui.find({ type: 'Text', text: /\d(?:\.\d+)?[kMB]? token/ }))?.text
    expect(meta).toBeDefined()
    expect(meta).not.toContain('crm-ext')
    expect(await ui.find({ type: 'Text', text: /^\$1\.50$/ })).toBeUndefined()
    if (surface === 'desktop') {
      // 会话行不画图片（上下文占用用文字）
      expect((await ui.findAll({ type: 'Svg' })).some(s => String(s.props.alt).startsWith('当前上下文'))).toBe(false)
    }
    // 项目头按钮按下后会换 key（尾部加 ~，让焦点环离开它），哪个在画面上就按哪个
    const pressProject = async (u: typeof ui) => {
      const plain = await u.find({ type: 'Button', key: 'proj-toggle-crm-ext' })
      await u.press({ key: plain ? 'proj-toggle-crm-ext' : 'proj-toggle-crm-ext~' })
    }
    // 搜索：不匹配时列表为空，清空后恢复
    await ui.input({ key: 'session-search', text: '不存在的关键字' })
    expect((await ui.find({ type: 'Text', text: /没有符合筛选条件的会话/ }))?.text).toBeDefined()
    await ui.input({ key: 'session-search', text: '' })
    expect((await ui.find({ type: 'Text', text: /测试会话标题/ }))?.text).toContain('测试会话标题')
    // 点项目行收起，再点展开
    await pressProject(ui)
    expect(await ui.find({ type: 'Text', text: /测试会话标题/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^›  crm-ext$/ }))?.text).toBe('›  crm-ext')
    await pressProject(ui)
    expect((await ui.find({ type: 'Text', text: /测试会话标题/ }))?.text).toContain('测试会话标题')
    // 展开后项目头的箭头变成「‹」（点它回到项目列表）
    expect((await ui.find({ type: 'Text', text: /^‹  crm-ext$/ }))?.text).toBe('‹  crm-ext')
    // 搜索时只有一个项目有结果：自动展开，即使之前手动收起了也直接看得到会话
    await pressProject(ui)
    expect(await ui.find({ type: 'Text', text: /测试会话标题/ })).toBeUndefined()
    await ui.input({ key: 'session-search', text: '测试会话' })
    expect((await ui.find({ type: 'Text', text: /测试会话标题/ }))?.text).toContain('测试会话标题')
    await ui.unmount()
  }

  // 宽面板：花费合成一张卡片（总数 → 每天 → 花在哪），构成表可在类型 / 模型间切换
  for (const surface of ['terminal', 'desktop'] as const) {
    const wide = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 120 } })
    expect((await wide.find({ type: 'Text', text: /^用量$/ }))?.text).toBe('用量')
    // 旧的三张卡片与活跃度都不再出现
    for (const gone of [/^钱花在哪$/, /^每日成本$/, /^花费$/, /^活动$/, /^活跃度$/]) {
      expect(await wide.find({ type: 'Text', text: gone })).toBeUndefined()
    }
    // 主数字下一排小指标：等价成本、会话、提问、缓存命中
    for (const label of [/^等价 API 成本$/, /^会话$/, /^提问$/, /^缓存命中$/]) {
      expect(await wide.find({ type: 'Text', text: label })).toBeDefined()
    }
    // 默认按类型：缓存读取等四类在表里
    expect((await wide.find({ type: 'Text', text: /^缓存读取$/ }))?.text).toBe('缓存读取')
    // 切到按模型：显示友好名，类型表收起
    await wide.press({ key: 'breakdown-model' })
    expect((await wide.find({ type: 'Text', text: /^Opus 5\.5$/ }))?.text).toBe('Opus 5.5')
    expect(await wide.find({ type: 'Text', text: /^缓存读取$/ })).toBeUndefined()
    await wide.press({ key: 'breakdown-type' })
    if (surface === 'desktop') {
      const svgs = await wide.findAll({ type: 'Svg' })
      // 卡片里只剩每日柱状图，不再有环形图
      expect(svgs.some(s => s.props.alt === '成本构成')).toBe(false)
      expect(svgs.every(s => typeof s.props.height === 'number')).toBe(true)
    }
    await wide.unmount()
  }

  // 窄面板（侧边栏默认宽度）：会话行精简，复制按钮用短标签，不出现双栏
  for (const surface of ['terminal', 'desktop'] as const) {
    const narrow = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 40 } })
    expect((await narrow.find({ type: 'Text', text: /测试会话标题/ }))?.text).toContain('测试会话标题')
    // 标题就是唯一的主操作（按下后 key 会加 ~，两种都认）。会话 s1 在 Desktop 里有记录且属于当前账号：
    // 桌面端点标题直接打开，不标「复制命令」；终端里一律复制，提示写在模块标题旁，行内也不标
    const openBtn = (await narrow.find({ type: 'Button', key: 'open-s1' })) ?? (await narrow.find({ type: 'Button', key: 'open-s1~' }))
    expect(openBtn).toBeDefined()
    expect(await narrow.find({ type: 'Text', text: /^复制命令$/ })).toBeUndefined()
    expect(await narrow.find({ type: 'Button', text: /^复制恢复命令$/ })).toBeUndefined()
    expect(await narrow.find({ type: 'Button', text: /^在 Desktop 打开$/ })).toBeUndefined()
    expect(await narrow.find({ type: 'Text', text: /^最后消息/ })).toBeUndefined()
    await narrow.unmount()
  }
  // 中等宽度：保留完整会话行
  const medium = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 70 } })
  expect((await medium.find({ type: 'Button', key: 'open-s1' })) ?? (await medium.find({ type: 'Button', key: 'open-s1~' }))).toBeDefined()
  expect(await medium.find({ type: 'Button', text: /^复制恢复命令$/ })).toBeUndefined()
  await medium.unmount()

  // 总览里没有返回洞察按钮（那只属于当前会话的实时页）
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', text: /返回洞察/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /测试会话标题/ }))?.text).toContain('测试会话标题')

  // 设置页：关掉金额后，用量卡片不再显示等价成本；排除项目后会话页签不再列出它
  await ui.press({ key: 'open-settings' })
  expect((await ui.find({ type: 'Text', text: /^插件设置$/ }))?.text).toBe('插件设置')
  await ui.press({ key: 'set-tg-money' })
  await ui.press({ key: 'set-tg-proj-crm-ext' })
  await ui.press({ key: 'open-settings' })
  expect(await ui.find({ type: 'Text', text: /^等价 API 成本$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /测试会话标题/ })).toBeUndefined()
  await ui.unmount()
})
