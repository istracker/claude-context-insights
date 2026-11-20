// 两个面板共用的格式化与小工具
import type { AccountMap, ContextDrop, FileFilter, RateSnapshot, RateWindow } from '../types'

/** 命令前缀：跳过它们，取后面真正执行的程序 */
const COMMAND_PREFIXES = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup'])

/** 取 Bash 命令的主程序名：跳过注释、cd、环境变量赋值和 sudo/env 等前缀，去掉路径 */
export function programOf(command: string): string | undefined {
  const segments = command
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .join('\n')
    .split(/&&|\|\||;|\||\n/)
  for (const raw of segments) {
    // 子 shell 的括号不是命令的一部分：(cd x && git status)
    const words = raw.trim().replace(/^[({]+\s*/, '').split(/\s+/).filter(Boolean)
    for (;;) {
      const w = words[0]
      if (w === undefined) break
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
        // FOO="a b" 带引号的值可能被空白拆成多段，跳到引号闭合处
        const quote = /^[A-Za-z_][A-Za-z0-9_]*=(["'])/.exec(w)?.[1]
        words.shift()
        const value = quote ? w.slice(w.indexOf(quote) + 1) : ''
        if (quote && !(value.length > 0 && value.endsWith(quote))) {
          while (words.length > 0 && !(words.shift() ?? '').endsWith(quote)) {
            // 继续跳过引号内的部分
          }
        }
        continue
      }
      if (COMMAND_PREFIXES.has(w)) {
        words.shift()
        // 前缀自带的选项：sudo -u root、env -i；-u/-g/-C 等还带一个参数
        while (words.length > 0 && (words[0] ?? '').startsWith('-')) {
          const opt = words.shift() ?? ''
          if (/^-[ugCphrt]$/.test(opt)) words.shift()
        }
        continue
      }
      break
    }
    const head = words[0]
    if (head === undefined || head === 'cd') continue
    return head.replace(/^.*\//, '')
  }
  return undefined
}

export function bump(map: Record<string, number>, key: string, by = 1): Record<string, number> {
  return { ...map, [key]: (map[key] ?? 0) + by }
}

export function fmtTokens(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '—'
  // 上下文压缩后的变化量是负数
  if (n < 0) return '-' + fmtTokens(-n)
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 10_000) return Math.round(n / 1000) + 'k'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

export function fmtUsd(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n >= 100) return '$' + n.toFixed(0)
  return n < 1 ? '$' + n.toFixed(3) : '$' + n.toFixed(2)
}

export function pct(part: number, whole: number): string {
  return whole > 0 ? ((part / whole) * 100).toFixed(1) + '%' : '—'
}

export function topEntries(map: Record<string, number>, n: number): [string, number][] {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
}

/** 文字进度条 */
export function textBar(percent: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** 终端里用的迷你趋势条 */
export function sparkline(values: number[], max: number): string {
  const bars = '▁▂▃▄▅▆▇█'
  return values
    .map(v => bars[Math.min(bars.length - 1, Math.floor((v / Math.max(max, 1)) * bars.length))] ?? '▁')
    .join('')
}

/**
 * 区块卡片：圆角细边框加内边距（参考 dsh-context 的卡片布局，让区块之间界线分明）。
 * 终端画成字符边框，桌面端画成圆角描边。
 */
export const CARD = { borderStyle: 'round', borderDimColor: true, paddingX: 'md', paddingY: 'sm' } as const

/**
 * 按绘制端取卡片样式。暗色背景上主题的 inactive 描边和过低的灰底几乎融进背景，
 * 所以用中性半透明灰描边 + 浅灰底（深浅主题下都有清晰界线）；终端仍是字符边框。
 */
export function cardStyle(surface: string) {
  if (surface === 'terminal') return CARD
  return {
    borderStyle: 'round',
    borderColor: 'rgba(127,127,127,0.32)',
    backgroundColor: 'rgba(127,127,127,0.10)',
    paddingX: 'md',
    paddingY: 'sm',
  } as const
}
/** 卡片的边框加左右内边距大约占掉的像素，图表要比面板窄这么多 */
const CARD_INSET = 40

/**
 * 卡片里图表的像素宽度估算：插件只拿得到能放多少个字符（bodyColumns）。
 * 图表都显式给了宽度，估大了右侧会被裁、估小了只是右边留白，所以宁小勿大：
 * 按每字符约 7.3px 估，扣掉面板左右内边距，再扣掉卡片的边框与内边距。
 */
export function paneWidths(bodyColumns: number): { full: number; half: number } {
  const body = Math.round(bodyColumns * 7.3) - 24
  const full = Math.max(240, body - CARD_INSET)
  // 两栏并排（每栏卡片至少 200px 图表 + 40px 边框内边距，加上栏间距 32px，共需 ~512px ≈ 74 列）
  const half = bodyColumns >= 74 ? Math.floor((body - 32) / 2) - CARD_INSET : full
  return { full, half }
}

/** 订阅额度窗口的中文名 */
export function windowLabel(kind: string): string {
  const names: Record<string, string> = {
    five_hour: '5 小时',
    seven_day: '7 天',
    seven_day_opus: '7 天 · Opus',
    seven_day_sonnet: '7 天 · Sonnet',
    spend_limit: '消费上限',
  }
  return names[kind] ?? kind
}

/** 距某时刻还有多久：「2 小时 10 分」「3 天」 */
export function fmtUntil(ms: number): string {
  if (Number.isNaN(ms)) return '—'
  if (ms <= 60_000) return '1 分钟内'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 === 0 ? `${h} 小时` : `${h} 小时 ${m % 60} 分`
  const d = Math.floor(h / 24)
  return h % 24 === 0 ? `${d} 天` : `${d} 天 ${h % 24} 小时`
}

export function fmtAgo(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  return `${d} 天前`
}

/** 按天粒度的相对时间：「今天」「昨天」「3 天前」（用于按天统计的排行） */
export function fmtDayAgo(day: string, today: string): string {
  const d = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(day + 'T00:00:00Z')) / 86_400_000)
  if (Number.isNaN(d) || d <= 0) return '今天'
  if (d === 1) return '昨天'
  return `${d} 天前`
}

/** 时间戳 → 本地时钟 HH:MM（tzMin 为东时区分钟数） */
export function fmtClockTime(ts: number, tzMin: number): string {
  const d = new Date(ts + tzMin * 60_000)
  if (Number.isNaN(d.getTime())) return '—'
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** 识别上下文骤降事件（前一步 >50k 且骤降至 60% 以下，视为压缩或清空） */
export function detectContextDrops(requests: { at: number; ctx: number }[]): ContextDrop[] {
  const drops: ContextDrop[] = []
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1]
    const cur = requests[i]
    if (!prev || !cur) continue
    if (prev.ctx > 50_000 && cur.ctx < prev.ctx * 0.6) {
      drops.push({ step: i + 1, at: cur.at, from: prev.ctx, to: cur.ctx })
    }
  }
  return drops
}

/** 按全部 / 读 / 写筛选文件活动并按操作次数降序排 */
export function filterFiles(
  files: Record<string, { r: number; w: number }>,
  filter: FileFilter,
): [string, { r: number; w: number }][] {
  const entries = Object.entries(files)
  if (filter === 'read') return entries.filter(([, f]) => f.r > 0).sort((a, b) => b[1].r - a[1].r || b[1].w - a[1].w)
  if (filter === 'write') return entries.filter(([, f]) => f.w > 0).sort((a, b) => b[1].w - a[1].w || b[1].r - a[1].r)
  return entries.sort((a, b) => b[1].r + b[1].w - (a[1].r + a[1].w) || b[1].w - a[1].w)
}

/** 截短文件路径显示最后两段，兼容 Unix 与 Windows 分隔符 */
export function shortFilePath(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || p
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c)
}

/**
 * 本会话属于哪个账号：先查会话归属（桌面端记录），再退回 current。
 * current 可能是旧代码或旧扫描算出来的（/reload-plugins 不会重新触发会话开始），会话归属更可靠。
 */
export function sessionAccount(acc: AccountMap, sessionId: string | undefined): string | undefined {
  return (sessionId !== undefined ? acc.bySession[sessionId] : undefined) ?? acc.current
}

/**
 * 两组额度读数是否出自同一个账号：每个窗口的重置时间都一致（至少两个窗口）。
 * 重置时间由账号自己的用量决定，不同账号的 5 小时与 7 天窗口同时撞上几乎不可能。
 */
export function sameAccountWindows(a: RateWindow[], b: RateWindow[]): boolean {
  const key = (ws: RateWindow[]) =>
    ws
      .filter(w => w.resetsAt)
      .map(w => `${w.kind}@${w.resetsAt}`)
      .sort()
      .join('|')
  const ka = key(a)
  return ka.split('|').length >= 2 && ka === key(b)
}

/** 去掉其他账号名下与这组读数同源的记录（以前把读数存错了账号留下的） */
export function dropMisfiledLimits(
  stored: Record<string, RateSnapshot>,
  account: string,
  windows: RateWindow[],
): Record<string, RateSnapshot> {
  return Object.fromEntries(
    Object.entries(stored).filter(([k, v]) => k === account || !sameAccountWindows(v.windows, windows)),
  )
}
