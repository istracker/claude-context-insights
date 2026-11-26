/** 主循环的一次模型请求 */
export type StepRecord = {
  at: number
  /** 本次请求的上下文大小 = input + cacheRead + cacheWrite */
  ctx: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  model: string
  tools: number
}

/** 整个会话的请求累计（steps 只保留最近若干条，统计不随之截断） */
export type StepTotals = {
  count: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** 工具、文件、命令活动计数（含子 Agent） */
export type Activity = {
  tools: Record<string, number>
  errors: number
  reads: number
  writes: number
  searches: number
  files: Record<string, { r: number; w: number }>
  programs: Record<string, number>
}

export type CategoryRow = {
  name: string
  tokens: number
  kind: 'used' | 'free' | 'buffer' | 'deferred'
  color: string
}

/** 上下文窗口快照 */
export type Snapshot = {
  at: number
  model?: string
  tokens?: number
  window: number
  percent?: number
  usd?: number
  hasUnknownPrice?: boolean
  detail?: 'summary' | 'full'
  categories: CategoryRow[]
  autoCompactAt?: number
  memoryFiles: number
  mcpTools: number
  skills: number
}

// ---------- 跨会话洞察 ----------

/** 某会话某一天的用量；排行类数据也按天记，才能和时间范围对齐 */
export type DayAgg = {
  in: number
  out: number
  cr: number
  /** 缓存写入合计（5 分钟 + 1 小时） */
  cw: number
  /** 其中 1 小时缓存写入（单价是 5 分钟的 1.6 倍） */
  cw1h: number
  req: number
  prompts: number
  models: Record<string, number>
  /** 各模型当天的计费权重，用于把当天成本按模型分摊 */
  modelWeight?: Record<string, number>
  tools: Record<string, number>
  /** 各工具当天往上下文塞入的估算 token（入参 + 返回结果按 4 字符≈1 token 折算） */
  toolTokens?: Record<string, number>
}

/** 一个日志文件（主会话或子 Agent）的汇总，存在 $.store 里，跨会话保留 */
export type SessionAgg = {
  /** 会话 id；子 Agent 文件用父会话 id */
  id: string
  file: string
  isSub: boolean
  /** 已读到的字节位置（总在换行之后） */
  offset: number
  size: number
  /** 正在跳过一行超过 4 MiB 的超长行 */
  skipping: boolean
  lastReq?: string
  /** 最近发起的 tool_use id → 工具名（用于把后续 tool_result 的大小归到对应工具） */
  pendingTools?: Record<string, string>
  cwd?: string
  title?: string
  lastPrompt?: string
  /** 最后一次请求的上下文大小（输入 + 缓存读 + 缓存写），即会话当前占用的上下文 */
  lastCtx?: number
  firstAt?: number
  lastAt?: number
  /** cost-state 记录的会话总成本（含子 Agent），本地估算 */
  costUsd?: number
  /** 计费权重累计（输入=1，5 分钟缓存写 1.25、1 小时 2、缓存读 0.05～0.1、输出 5） */
  weight: number
  /** 读到最后一条 cost-state 时的权重累计；之后的部分要另行估算 */
  costAtWeight?: number
  days: Record<string, DayAgg>
}

/** 上下文骤降事件（压缩或清空） */
export type ContextDrop = {
  /** 第几次请求（从 1 开始） */
  step: number
  at: number
  from: number
  to: number
}

/** 文件活动筛选 */
export type FileFilter = 'all' | 'read' | 'write'

/** 一个订阅额度窗口 */
export type RateWindow = {
  /** five_hour / seven_day / spend_limit … */
  kind: string
  percentUsed: number
  resetsAt?: string
}

/** 某账号最近一次读到的额度 */
export type RateSnapshot = {
  at: number
  windows: RateWindow[]
}

export type ScanState = {
  isRunning: boolean
  doneFiles: number
  totalFiles: number
  doneBytes: number
  totalBytes: number
  finishedAt?: number
  error?: string
  /** 统计日期用的时区，东区分钟数 */
  tzMin?: number
}

/** 时间范围：分段控件给今天 / 近 7 天 / 近 30 天，下拉里再多昨天、本月、上月、全部 */
export type InsightRange = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'lastMonth' | 'all'
/** 顶部页签 */
export type InsightTab = 'overview' | 'sessions' | 'tools' | 'settings'

/** 插件设置：跨会话保存在 $.store */
export type InsightSettings = {
  /** 新开会话时是否自动打开面板，默认关闭 */
  autoOpen?: boolean
  /** 是否显示等价 API 金额，默认显示 */
  showMoney?: boolean
  /** 不统计的项目名 */
  excluded?: string[]
  /** 账号显示名：账号 id → 显示名，优先于 accounts.json */
  aliases?: Record<string, string>
}

/** 花费构成的维度 */
export type Breakdown = 'type' | 'model' | 'account'

export type InsightSort = 'recent' | 'tokens' | 'cost' | 'context'

export type InsightView = {
  range: InsightRange
  sort: InsightSort
  /** 热力图点选的某一天，YYYY-MM-DD */
  day?: string
  /** 工具排行是否展开 MCP 明细 */
  expandMcp?: boolean
  /** 会话列表当前页（从 0 开始） */
  page?: number
  /** 会话列表按项目分组筛选 */
  project?: string
  /** 顶部页签：总览、会话、工具 */
  tab?: InsightTab
  /** 会话按项目分组：展开的项目（手风琴，只取第一个；不填时默认展开第一个项目） */
  openProjects?: string[]
  /** 展开项目里的会话页码（从 0 开始） */
  sessionPage?: number
  /** 每次展开/翻页加一：用来给按钮换 key，让宿主的焦点环离开已按下的按钮（见 insights 里的 fk） */
  focusEpoch?: number
  /** 会话搜索：按标题、项目、最后消息过滤 */
  query?: string
  /** 花费卡片的构成表看哪个维度 */
  breakdown?: Breakdown
  /** 工具上下文排序：累计 token 或平均每次 */
  toolSort?: 'total' | 'avg'
  /** 账号筛选：账号 id，'none' 为未归属；不填为全部 */
  account?: string
  /** 排行里点选的一项：会话列表只列用过它的会话 */
  pick?: { kind: RankKind; key: string }
  /** 哪些排行已展开显示全部 */
  openRanks?: RankKind[]
  /** 会话详情页的文件活动筛选 */
  fileFilter?: FileFilter
  /** 会话详情页是否展开全部文件 */
  showAllFiles?: boolean
}

/** 「更多」里可点选筛选的排行 */
export type RankKind = 'model' | 'tool'

/** 账号的显示信息，见过一次就记住 */
export type AccountLabel = {
  email?: string
  /** 设置里填的显示名，优先于邮箱 */
  alias?: string
  name?: string
}

/** 会话 → 账号：来自 Claude Desktop 的 claude-code-sessions/<账号>/<组织>/local_*.json */
export type AccountMap = {
  bySession: Record<string, string>
  /** CLI 会话 id → Claude Desktop 里的会话 id（local_…），用来在 Desktop 里直接打开该会话 */
  desktopBySession: Record<string, string>
  /** CLI 会话 id → Desktop 里的标题与归档状态（只记当前日志 id；标题与侧边栏一致） */
  desktopMeta?: Record<string, { title?: string; isArchived?: boolean }>
  labels: Record<string, AccountLabel>
  /** 当前登录的账号 */
  current?: string
}

declare module 'claude-code' {
  interface PluginState {
    'cc-context-insights': {
      steps: Shaped<StepRecord[]>
      'step-totals': Shaped<StepTotals>
      turns: Shaped<number>
      activity: Shaped<Activity>
      snapshot: Shaped<Snapshot | null>
      busy: Shaped<boolean>
      sessions: Shaped<SessionAgg[]>
      scan: Shaped<ScanState>
      view: Shaped<InsightView>
      settings: Shaped<InsightSettings>
      accounts: Shaped<AccountMap>
      /** 各账号最近一次的额度读数，键为账号 id */
      limits: Shaped<Record<string, RateSnapshot>>
      /** 本会话最近一次实时拉取的额度（短期缓存，避免高频重渲染重复调 usage） */
      'live-limits': Shaped<RateSnapshot | null>
      /** 正在查看哪个会话的上下文；null 为洞察总览 */
      focus: Shaped<string | null>
      /** 正在查看的非当前会话的详情 */
    }
  }
}
