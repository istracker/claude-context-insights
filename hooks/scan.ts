// 扫描 ~/.claude/projects 下的会话日志，增量汇总到 $.store
import type { EngineInterface } from 'claude-code'

import type {
  AccountLabel,
  AccountMap,
  DayAgg,
  DetailRequest,
  ScanState,
  SessionAgg,
  SessionDetail,
} from '../types'
import { NO_ACCOUNTS, setAccounts, setDetail, setScanState, setSessions } from './state'
import { addCount, billingWeight, detectContextDrops, programOf } from './util'

export { billingWeight }

const LABELS_KEY = 'account-labels-1'
const CHUNK = 4 * 1024 * 1024
const STORE_PREFIX = 'agg4:'
/** 旧版本的缓存前缀，扫描时清掉 */
const OLD_PREFIXES = ['agg1:', 'agg2:', 'agg3:']
const MAP_CAP = 40

export function emptyAgg(id: string, file: string, isSub: boolean): SessionAgg {
  return {
    id,
    file,
    isSub,
    offset: 0,
    size: 0,
    skipping: false,
    weight: 0,
    days: {},
  }
}

function emptyDay(): DayAgg {
  return { in: 0, out: 0, cr: 0, cw: 0, cw1h: 0, req: 0, prompts: 0, models: {}, tools: {}, skills: {}, programs: {}, hours: {} }
}

/** 时间戳 → 本地小时 0–23 */
export function hourOf(ts: number, tzMin: number): number {
  return new Date(ts + tzMin * 60_000).getUTCHours()
}

/** 时间戳 → 本地日期 YYYY-MM-DD（tzMin 为东时区分钟数，北京时间 480） */
export function dayKey(ts: number, tzMin: number): string {
  return new Date(ts + tzMin * 60_000).toISOString().slice(0, 10)
}

type Json = Record<string, unknown>

function obj(v: unknown): Json | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function touch(agg: SessionAgg, d: Json): number | undefined {
  const t = str(d.timestamp)
  const ts = t ? Date.parse(t) : NaN
  if (Number.isNaN(ts)) return undefined
  if (agg.firstAt === undefined || ts < agg.firstAt) agg.firstAt = ts
  if (agg.lastAt === undefined || ts > agg.lastAt) agg.lastAt = ts
  const cwd = str(d.cwd)
  if (cwd) agg.cwd = cwd
  return ts
}

function dayOf(agg: SessionAgg, ts: number, tzMin: number): DayAgg {
  const k = dayKey(ts, tzMin)
  const day = agg.days[k] ?? emptyDay()
  agg.days[k] = day
  return day
}

/**
 * 吃进一行日志，就地改 agg。
 * 一次 API 响应在日志里按内容块拆成多行，usage 相同且连续出现：requestId 变化时才计用量。
 */
export function ingestLine(agg: SessionAgg, line: string, tzMin: number): void {
  if (line.length === 0) return
  if (line.includes('"type":"assistant"')) {
    const d = parse(line)
    if (!d || d.type !== 'assistant') return
    const msg = obj(d.message)
    if (!msg) return
    const ts = touch(agg, d)
    const usage = obj(msg.usage)
    const model = str(msg.model) ?? 'unknown'
    const req = str(d.requestId) ?? str(msg.id)
    if (usage && ts !== undefined && model !== '<synthetic>' && req !== agg.lastReq) {
      agg.lastReq = req
      const day = dayOf(agg, ts, tzMin)
      const tin = num(usage.input_tokens)
      const tout = num(usage.output_tokens)
      const tcr = num(usage.cache_read_input_tokens)
      const tcw = num(usage.cache_creation_input_tokens)
      const tcw1h = num(obj(usage.cache_creation)?.ephemeral_1h_input_tokens)
      day.in += tin
      day.out += tout
      day.cr += tcr
      day.cw += tcw
      day.cw1h += tcw1h
      agg.weight += billingWeight(tin, tout, tcr, tcw, tcw1h, model)
      day.req += 1
      addCount(day.models, model)
      addCount(day.hours, String(hourOf(ts, tzMin)))
    }
    if (ts === undefined) return
    const day = dayOf(agg, ts, tzMin)
    const content = Array.isArray(msg.content) ? msg.content : []
    for (const raw of content) {
      const block = obj(raw)
      if (!block || block.type !== 'tool_use') continue
      const name = str(block.name) ?? 'unknown'
      addCount(day.tools, name)
      const input = obj(block.input)
      if (name === 'Skill') {
        const skill = str(input?.skill)
        if (skill) addCount(day.skills, skill)
      } else if (name === 'Bash') {
        const cmd = str(input?.command)
        const prog = cmd ? programOf(cmd) : undefined
        if (prog) addCount(day.programs, prog)
      }
    }
    return
  }
  if (line.includes('"type":"user"') && line.includes('"turnOrigin":"human"')) {
    const d = parse(line)
    if (!d || d.type !== 'user') return
    const ts = touch(agg, d)
    if (ts !== undefined) dayOf(agg, ts, tzMin).prompts += 1
    return
  }
  if (line.startsWith('{"type":"cost-state"')) {
    const d = parse(line)
    if (d && typeof d.totalCostUSD === 'number') {
      agg.costUsd = d.totalCostUSD
      agg.costAtWeight = agg.weight
    }
    return
  }
  if (line.startsWith('{"type":"custom-title"')) {
    const t = str(parse(line)?.customTitle)
    if (t) agg.title = t
    return
  }
  if (line.startsWith('{"type":"last-prompt"')) {
    const t = str(parse(line)?.lastPrompt)
    if (t) agg.lastPrompt = t.slice(0, 80)
  }
}

function parse(line: string): Json | undefined {
  try {
    return obj(JSON.parse(line))
  } catch {
    return undefined
  }
}

function capMap(map: Record<string, number>): Record<string, number> {
  const entries = Object.entries(map)
  if (entries.length <= MAP_CAP) return map
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAP_CAP))
}

const fromBase64: (s: string) => Uint8Array =
  (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64 ??
  ((s: string) => {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  })

/** 从 agg.offset 读到文件末尾最后一个换行，返回新读的字节数 */
export async function scanFile(
  $: EngineInterface,
  agg: SessionAgg,
  size: number,
  tzMin: number,
  onBytes: (n: number) => Promise<void>,
): Promise<void> {
  if (size < agg.offset) {
    // 文件被截断或重写：从头再来
    Object.assign(agg, emptyAgg(agg.id, agg.file, agg.isSub))
  }
  const decoder = new TextDecoder('utf-8')
  while (agg.offset < size) {
    const length = Math.min(CHUNK, size - agg.offset)
    const got = await $.fs.read(agg.file, { as: 'bytes', offset: agg.offset, length })
    const bytes = fromBase64(got.base64)
    if (bytes.length === 0) break
    const lastNl = bytes.lastIndexOf(10)
    if (lastNl < 0) {
      if (bytes.length < CHUNK) break // 末尾一行还没写完，下次再读
      // 超过 4 MiB 的一行（通常是图片或超大工具结果），整行跳过
      agg.skipping = true
      agg.offset += bytes.length
      await onBytes(bytes.length)
      continue
    }
    const lines = decoder.decode(bytes.subarray(0, lastNl)).split('\n')
    if (agg.skipping) {
      lines.shift()
      agg.skipping = false
    }
    for (const line of lines) ingestLine(agg, line, tzMin)
    agg.offset += lastNl + 1
    await onBytes(lastNl + 1)
  }
  agg.size = size
  for (const d of Object.values(agg.days)) {
    d.tools = capMap(d.tools)
    d.skills = capMap(d.skills)
    d.programs = capMap(d.programs)
  }
}

type Target = { file: string; id: string; isSub: boolean; size: number }

async function listTargets($: EngineInterface, root: string): Promise<Target[]> {
  const out: Target[] = []
  const projects = await $.fs.list(root).catch(() => [])
  for (const p of projects) {
    if (p.kind !== 'dir') continue
    const dir = `${root}/${p.name}`
    const entries = await $.fs.list(dir).catch(() => [])
    for (const e of entries) {
      if (e.kind === 'file' && e.name.endsWith('.jsonl')) {
        out.push({ file: `${dir}/${e.name}`, id: e.name.slice(0, -6), isSub: false, size: e.size })
      } else if (e.kind === 'dir' && e.name !== 'memory') {
        const subDir = `${dir}/${e.name}/subagents`
        const subs = await $.fs.list(subDir).catch(() => [])
        for (const s of subs) {
          if (s.kind === 'file' && s.name.endsWith('.jsonl')) {
            out.push({ file: `${subDir}/${s.name}`, id: e.name, isSub: true, size: s.size })
          }
        }
      }
    }
  }
  return out
}

/** 桌面端 local_*.json 的内存缓存（仅在文件有有效 mtime 时启用，避免重复串行读盘） */
const desktopSessionCache = new Map<string, { size: number; mtimeMs: number; ids: string[] }>()

/**
 * 会话 → 账号。Claude Desktop 把每个 Code 会话记在
 * claude-code-sessions/<账号 id>/<组织 id>/local_*.json，其中 cliSessionId 就是日志文件名。
 * 当前登录账号与邮箱来自 ~/.claude.json 的 oauthAccount；见过的邮箱记在 $.store，切换账号后仍能显示。
 */
export async function loadAccounts(
  $: EngineInterface,
  home: string,
  currentSessionId?: string,
  opts?: { claudeDir?: string; appData?: string },
): Promise<AccountMap> {
  const candidates = [
    `${home}/Library/Application Support/Claude/claude-code-sessions`,
    ...(opts?.appData ? [`${opts.appData}/Claude/claude-code-sessions`] : []),
    `${home}/.config/Claude/claude-code-sessions`,
  ]
  let base = candidates[0]!
  let accts = await $.fs.list(base).catch(() => [])
  for (let i = 1; i < candidates.length && accts.length === 0; i++) {
    const next = await $.fs.list(candidates[i]!).catch(() => [])
    if (next.length > 0) {
      base = candidates[i]!
      accts = next
    }
  }

  const bySession: Record<string, string> = {}
  for (const acct of accts) {
    if (acct.kind !== 'dir') continue
    for (const org of await $.fs.list(`${base}/${acct.name}`).catch(() => [])) {
      if (org.kind !== 'dir') continue
      const dir = `${base}/${acct.name}/${org.name}`
      for (const f of await $.fs.list(dir).catch(() => [])) {
        if (f.kind !== 'file' || !f.name.endsWith('.json') || f.size > CHUNK) continue
        const filePath = `${dir}/${f.name}`
        const cached = f.mtimeMs > 0 ? desktopSessionCache.get(filePath) : undefined
        let ids: string[]
        if (cached && cached.size === f.size && cached.mtimeMs === f.mtimeMs) {
          ids = cached.ids
        } else {
          const d = parse(await $.fs.read(filePath).catch(() => ''))
          // 桌面会话回退/重来后会换新的 CLI 会话 id，旧 id 记在 priorCliSessionIds
          const prior = Array.isArray(d?.priorCliSessionIds) ? d.priorCliSessionIds : []
          ids = [d?.cliSessionId, d?.lastAssistantCliSessionId, ...prior].filter((id): id is string => typeof id === 'string' && id.length > 0)
          if (f.mtimeMs > 0) desktopSessionCache.set(filePath, { size: f.size, mtimeMs: f.mtimeMs, ids })
        }
        for (const id of ids) bySession[id] = acct.name
      }
    }
  }

  const stored = obj(await $.store.get(LABELS_KEY)) ?? {}
  const labels: Record<string, AccountLabel> = {}
  for (const [k, v] of Object.entries(stored)) {
    const o = obj(v)
    if (o) labels[k] = { email: str(o.email), name: str(o.name) }
  }
  // 当前账号：优先看本会话记在桌面端哪个账号目录下。
  // ~/.claude.json 的 oauthAccount 是 CLI 的登录账号，桌面端可以登录另一个账号，不能只信它
  let current: string | undefined = currentSessionId ? bySession[currentSessionId] : undefined
  const cfg = parse(await $.fs.read(`${home}/.claude.json`).catch(() => ''))
  const oauth = obj(cfg?.oauthAccount)
  const uuid = str(oauth?.accountUuid)
  if (uuid) {
    current ??= uuid
    // 邮箱与 uuid 一一对应，不论它是不是当前账号都可以记下
    const label: AccountLabel = { email: str(oauth?.emailAddress), name: str(oauth?.displayName) }
    const old = labels[uuid]
    if (old?.email !== label.email || old?.name !== label.name) {
      labels[uuid] = label
      await $.store.set(LABELS_KEY, labels)
    }
  }
  // 手工别名：<claudeDir>/cc-context-insights/accounts.json，{ "<账号 id>": "显示名" }，优先级最高
  const claudeDir = opts?.claudeDir || `${home}/.claude`
  const aliases = obj(parse(await $.fs.read(`${claudeDir}/cc-context-insights/accounts.json`).catch(() => '')))
  for (const [id, v] of Object.entries(aliases ?? {})) {
    const name = str(v)
    if (name) labels[id] = { ...labels[id], email: name }
  }
  return { bySession, labels, current }
}

// ---------- 单个会话的上下文详情（双击会话时按需读取） ----------

const DETAIL_POINTS = 400
const FILE_TOOLS = new Set(['Read', 'NotebookRead', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const WRITE_FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** 每次开始加载加一；加载途中发现它变了就放弃（用户又双击了别的会话或返回总览） */
let detailToken = 0

/** 返回总览时取消正在进行的后台详情读取 */
export function cancelSessionDetail(): void {
  detailToken += 1
}

/** 把逐请求序列均匀抽样到至多 n 个点，保留首尾 */
export function downsample<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list
  const out: T[] = []
  for (let i = 0; i < n; i++) out.push(list[Math.round((i * (list.length - 1)) / (n - 1))] as T)
  return out
}

/**
 * 从主会话日志还原上下文详情：逐请求的上下文大小、压缩次数、模型、工具、文件与命令。
 * 按 4 MiB 分块读，每块更新一次进度。
 */
export async function loadSessionDetail($: EngineInterface, id: string, file: string): Promise<void> {
  const token = ++detailToken
  const size = await $.fs
    .stat(file)
    .then(s => s.size)
    .catch(() => 0)
  const base: SessionDetail = {
    id,
    status: 'loading',
    doneBytes: 0,
    totalBytes: size,
    requests: [],
    requestCount: 0,
    lastCtx: 0,
    maxCtx: 0,
    compactions: 0,
    drops: [],
    tools: {},
    programs: {},
    files: {},
  }
  await setDetail($, () => base)

  const requests: DetailRequest[] = []
  const models: Record<string, number> = {}
  const tools: Record<string, number> = {}
  const programs: Record<string, number> = {}
  const files: Record<string, { r: number; w: number }> = {}
  let lastReq: string | undefined
  const onLine = (line: string) => {
    if (!line.includes('"type":"assistant"')) return
    const d = parse(line)
    if (!d || d.type !== 'assistant') return
    const msg = obj(d.message)
    if (!msg) return
    const usage = obj(msg.usage)
    const model = str(msg.model) ?? 'unknown'
    const req = str(d.requestId) ?? str(msg.id)
    const t = str(d.timestamp)
    const at = t ? Date.parse(t) : NaN
    if (usage && model !== '<synthetic>' && req !== lastReq && !Number.isNaN(at)) {
      lastReq = req
      requests.push({
        at,
        ctx:
          num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens),
        out: num(usage.output_tokens),
      })
      addCount(models, model)
    }
    for (const raw of Array.isArray(msg.content) ? msg.content : []) {
      const block = obj(raw)
      if (!block || block.type !== 'tool_use') continue
      const name = str(block.name) ?? 'unknown'
      addCount(tools, name)
      const input = obj(block.input)
      if (name === 'Bash') {
        const cmd = str(input?.command)
        const prog = cmd ? programOf(cmd) : undefined
        if (prog) addCount(programs, prog)
      }
      // NotebookEdit 的路径参数叫 notebook_path
      const path = str(input?.file_path) ?? str(input?.notebook_path)
      if (path && FILE_TOOLS.has(name)) {
        const f = files[path] ?? { r: 0, w: 0 }
        files[path] = WRITE_FILE_TOOLS.has(name) ? { r: f.r, w: f.w + 1 } : { r: f.r + 1, w: f.w }
      }
    }
  }

  try {
    const decoder = new TextDecoder('utf-8')
    let offset = 0
    let skipping = false
    while (offset < size) {
      const length = Math.min(CHUNK, size - offset)
      const got = await $.fs.read(file, { as: 'bytes', offset, length })
      if (token !== detailToken) return
      const bytes = fromBase64(got.base64)
      if (bytes.length === 0) break
      const lastNl = bytes.lastIndexOf(10)
      if (lastNl < 0) {
        if (bytes.length < CHUNK) break
        skipping = true
        offset += bytes.length
        continue
      }
      const lines = decoder.decode(bytes.subarray(0, lastNl)).split('\n')
      if (skipping) {
        lines.shift()
        skipping = false
      }
      for (const line of lines) onLine(line)
      offset += lastNl + 1
      await setDetail($, d => (d && d.id === id ? { ...d, doneBytes: offset } : d))
    }
    requests.sort((a, b) => a.at - b.at)
    const drops = detectContextDrops(requests)
    const done: SessionDetail = {
      ...base,
      status: 'ready',
      doneBytes: size,
      requests: downsample(requests, DETAIL_POINTS),
      requestCount: requests.length,
      model: Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0],
      lastCtx: requests[requests.length - 1]?.ctx ?? 0,
      maxCtx: requests.reduce((m, r) => Math.max(m, r.ctx), 0),
      compactions: drops.length,
      drops,
      tools,
      programs,
      files,
    }
    if (token === detailToken) await setDetail($, () => done)
  } catch (err) {
    if (token === detailToken) {
      await setDetail($, d => (d ? { ...d, status: 'error' as const, error: String(err) } : d))
    }
  }
}

let running = false

/** 增量扫描所有会话日志；已在跑就直接返回 */
export async function runScan($: EngineInterface): Promise<void> {
  if (running) return
  running = true
  const setScan = (fn: (s: ScanState) => ScanState) => setScanState($, fn)
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    const claudeDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
    const appData = await $.env.get('APPDATA')
    const root = `${claudeDir}/projects`
    const tzMin = await localTzMinutes($)
    const targets = await listTargets($, root)
    const sessionId = await $.session.id().catch(() => undefined)
    const accounts = await loadAccounts($, home, sessionId, { claudeDir, appData }).catch(() => NO_ACCOUNTS)
    await setAccounts($, () => accounts)

    // 读出缓存
    const cached = new Map<string, SessionAgg>()
    for (const key of await $.store.keys()) {
      if (OLD_PREFIXES.some(p => key.startsWith(p))) {
        await $.store.delete(key)
        continue
      }
      if (!key.startsWith(STORE_PREFIX)) continue
      const v = (await $.store.get(key)) as SessionAgg | undefined
      if (v && typeof v.offset === 'number' && typeof v.days === 'object' && typeof v.weight === 'number') cached.set(v.file, v)
    }
    const alive = new Set(targets.map(t => t.file))
    for (const file of cached.keys()) {
      if (!alive.has(file)) {
        cached.delete(file)
        await $.store.delete(STORE_PREFIX + file)
      }
    }

    const todo = targets.filter(t => (cached.get(t.file)?.size ?? -1) !== t.size)
    // 文件被截断变小时会从 0 重读，按 t.size 计待读字节，避免进度超过 100%
    const totalBytes = todo.reduce((s, t) => {
      const prevOff = cached.get(t.file)?.offset ?? 0
      return s + (t.size < prevOff ? t.size : t.size - prevOff)
    }, 0)
    await setScan(() => ({ isRunning: true, doneFiles: 0, totalFiles: todo.length, doneBytes: 0, totalBytes, tzMin }))
    await setSessions($, () => [...cached.values()])

    let done = 0
    let doneBytes = 0
    for (const t of todo) {
      const agg = cached.get(t.file) ?? emptyAgg(t.id, t.file, t.isSub)
      await scanFile($, agg, t.size, tzMin, async n => {
        doneBytes += n
        // 大文件分块读时实时推进进度条，小文件随批次统一刷，减少重渲染风暴
        if (t.size > CHUNK) await setScan(s => ({ ...s, doneBytes }))
      })
      cached.set(t.file, agg)
      await $.store.set(STORE_PREFIX + t.file, agg)
      done += 1
      // 每处理 5 个文件刷一次进度与会话列表
      if (done % 5 === 0 || done === todo.length) {
        await setScan(s => ({ ...s, doneFiles: done, doneBytes }))
        await setSessions($, () => [...cached.values()])
      }
    }
    await setSessions($, () => [...cached.values()])
    const now = await $.clock.now()
    await setScan(s => ({ ...s, isRunning: false, doneFiles: done, doneBytes, finishedAt: now }))
  } catch (err) {
    await setScan(s => ({ ...s, isRunning: false, error: String(err) }))
  } finally {
    running = false
  }
}

/** 本地时区相对 UTC 的分钟数；模块环境的时区可能不是用户的，所以优先读 TZ */
async function localTzMinutes($: EngineInterface): Promise<number> {
  const tz = await $.env.get('TZ')
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date())
      const name = parts.find(p => p.type === 'timeZoneName')?.value ?? ''
      const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name)
      if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0))
    } catch {
      // Intl 不可用就退回下面
    }
  }
  return -new Date().getTimezoneOffset()
}
