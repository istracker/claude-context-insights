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
  tools: Record<string, number>
  skills: Record<string, number>
  programs: Record<string, number>
  /** 按本地小时（"0"–"23"）计的请求数 */
  hours: Record<string, number>
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
  cwd?: string
  title?: string
  lastPrompt?: string
  firstAt?: number
  lastAt?: number
  /** cost-state 记录的会话总成本（含子 Agent），本地估算 */
  costUsd?: number
  /** 计费权重累计（输入=1，5 分钟缓存写 1.25、1 小时 2、缓存读 0.1、输出 5） */
  weight: number
  /** 读到最后一条 cost-state 时的权重累计；之后的部分要另行估算 */
  costAtWeight?: number
  days: Record<string, DayAgg>
}

/** 从日志还原的一次请求 */
export type DetailRequest = {
  at: number
  /** 这次请求的上下文大小 = 输入 + 缓存读 + 缓存写 */
  ctx: number
  out: number
}

/** 双击会话后看到的上下文详情（非当前会话，从日志还原） */
export type SessionDetail = {
  id: string
  status: 'loading' | 'ready' | 'error'
  error?: string
  doneBytes: number
  totalBytes: number
  /** 逐请求的上下文大小，超过 400 个时按时间均匀抽样 */
  requests: DetailRequest[]
  requestCount: number
  model?: string
  lastCtx: number
  maxCtx: number
  /** 上下文骤降（被压缩或清空）的次数 */
  compactions: number
  tools: Record<string, number>
  programs: Record<string, number>
  files: Record<string, { r: number; w: number }>
}

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

export type InsightRange = 'today' | '7d' | '30d' | 'all'
export type InsightSort = 'recent' | 'tokens' | 'cost'

export type InsightView = {
  range: InsightRange
  sort: InsightSort
  /** 热力图点选的某一天，YYYY-MM-DD */
  day?: string
  /** 工具排行是否展开 MCP 明细 */
  expandMcp?: boolean
  /** 会话列表是否显示全部 */
  showAllSessions?: boolean
  /** 是否展开「更多」：项目、时段、工具、命令等 */
  showActivity?: boolean
  /** 账号筛选：账号 id，'none' 为未归属；不填为全部 */
  account?: string
}

/** 账号的显示信息，见过一次就记住 */
export type AccountLabel = {
  email?: string
  name?: string
}

/** 会话 → 账号：来自 Claude Desktop 的 claude-code-sessions/<账号>/<组织>/local_*.json */
export type AccountMap = {
  bySession: Record<string, string>
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
      accounts: Shaped<AccountMap>
      /** 各账号最近一次的额度读数，键为账号 id */
      limits: Shaped<Record<string, RateSnapshot>>
      /** 正在查看哪个会话的上下文；null 为洞察总览 */
      focus: Shaped<string | null>
      /** 正在查看的非当前会话的详情 */
      detail: Shaped<SessionDetail | null>
    }
  }
}
