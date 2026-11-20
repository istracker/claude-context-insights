// 图表：纯函数生成 SVG 字符串。
// 宽度由调用方按面板宽度给出（1 单位 = 1 像素），字号因此始终是真实的 12px；
// 估宽偏大时 max-width:100% 让它等比缩回面板内。
// 颜色走 CSS 变量，跟随系统深浅色。配色取自 Claude 自己的上下文用量界面：
// 蓝为主色，橙、青绿、琥珀、灰依次用于分类；底色与文字是中性灰。
import { escapeXml, fmtTokens, fmtUsd } from './util'

export const BLUE = '#257DE0'
export const ORANGE = '#F47130'
export const TEAL = '#00B894'
export const AMBER = '#F2A600'
export const GREY = '#878787'
/** 单一序列图表的主色 */
export const ACCENT = BLUE

/** 分类色，顺序与 Claude 上下文用量界面一致；超出时再取几种同风格的补充色 */
export const PALETTE = [BLUE, ORANGE, TEAL, AMBER, GREY, '#8B5CF6', '#E5484D', '#5BB3E8']

const STYLE = `<style>
:root{--ink:#191919;--muted:#666666;--grid:#EDEDED;--track:#EDEDED}
@media (prefers-color-scheme:dark){:root{--ink:#ECECEC;--muted:#9A9A9A;--grid:#333333;--track:#363636}}
text{font:500 12px -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;fill:var(--muted)}
.ink{fill:var(--ink)}.strong{font-weight:600}
.grid{stroke:var(--grid)}.track{fill:var(--track)}
.dim{opacity:.42}
@media (prefers-color-scheme:dark){.dim{opacity:.62}}
.row:hover .bar{opacity:1}
</style>`

function svg(w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="max-width:100%;height:auto">${STYLE}${body}</svg>`
}

const clampW = (w: number, min: number) => Math.max(min, Math.round(w))

/**
 * 取出 SVG 自身的宽高，交给 <Svg width height>。
 * 桌面端把可交互 SVG 放进内嵌框，不给高度时框默认 150px：高的图被截断、矮的留空白。
 */
export function svgSize(source: string): { width: number; height: number } {
  const m = /<svg[^>]*?\swidth="(\d+(?:\.\d+)?)"[^>]*?\sheight="(\d+(?:\.\d+)?)"/.exec(source)
  return { width: Number(m?.[1] ?? 300), height: Number(m?.[2] ?? 150) }
}

/** 坐标轴金额：$0、$25、$1.5k */
function axisUsd(v: number): string {
  if (v === 0) return '$0'
  if (v >= 1000) return '$' + (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k'
  if (v >= 10) return '$' + Math.round(v)
  return '$' + (Number.isInteger(v) ? v : v.toFixed(1))
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p
  return 10 * p
}

export type DayPoint = { day: string; usd: number; tokens: number; req: number; prompts: number }

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

/** 日均：按区间天数平均（没花钱的日子也算在内） */
export function dailyAverage(series: DayPoint[]): number {
  return series.length === 0 ? 0 : series.reduce((a, s) => a + s.usd, 0) / series.length
}

/**
 * 每日成本：柱 + 日均虚线。今天的柱子实色，其余半透明。
 * 今天的金额和日均都放在标题旁，图内不标数字：窄屏或相邻柱较高时标签必然相撞。
 */
export function dailySvg(series: DayPoint[], width = 520): string {
  const W = clampW(width, 240)
  const H = 180
  if (series.length === 0) return svg(W, H, '')
  const left = 44
  const right = 16
  const top = 22
  const bottom = 26
  const plotW = W - left - right
  const plotH = H - top - bottom
  const max = niceMax(Math.max(...series.map(s => s.usd)))
  const y = (v: number) => top + plotH - (v / max) * plotH
  const grid = [0, 0.5, 1]
    .map(f => {
      const yy = y(max * f)
      return `<line class="grid" x1="${left}" x2="${left + plotW}" y1="${yy}" y2="${yy}" stroke-width="1"/><text x="${left - 10}" y="${yy + 4}" text-anchor="end">${axisUsd(max * f)}</text>`
    })
    .join('')
  const n = series.length
  const slot = plotW / n
  const bw = Math.min(40, slot * 0.6)
  // 横轴标签：最多放约 plotW/56 个，从今天往前等距取
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 56))))
  const avg = dailyAverage(series)
  const bars = series
    .map((s, i) => {
      const isLast = i === n - 1
      const h = Math.max((s.usd / max) * plotH, s.usd > 0 ? 2 : 0)
      const x = left + i * slot + (slot - bw) / 2
      const cx = x + bw / 2
      const d = new Date(s.day + 'T00:00:00Z')
      const showLabel = (n - 1 - i) % every === 0
      const text = n <= 7 ? (isLast ? '今天' : '周' + WEEK[d.getUTCDay()]) : isLast ? '今天' : s.day.slice(5).replace('-', '/')
      const label = showLabel
        ? `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle"${isLast ? ' class="ink strong"' : ''}>${text}</text>`
        : ''
      const tip = `${s.day}\n${fmtUsd(s.usd)} · ${s.prompts} 次提问 · ${s.req} 次请求\n${fmtTokens(s.tokens)} token`
      return `<g class="row"><title>${escapeXml(tip)}</title><rect x="${(left + i * slot).toFixed(1)}" y="${top}" width="${slot.toFixed(1)}" height="${plotH}" fill="transparent"/><rect class="bar${isLast ? '' : ' dim'}" x="${x.toFixed(1)}" y="${(top + plotH - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${ACCENT}"/></g>${label}`
    })
    .join('')
  const avgLine =
    avg > 0
      ? `<line x1="${left}" x2="${left + plotW}" y1="${y(avg).toFixed(1)}" y2="${y(avg).toFixed(1)}" stroke="${GREY}" stroke-width="1" stroke-dasharray="3 4" opacity="0.8"><title>日均 ${fmtUsd(avg)}</title></line>`
      : ''
  return svg(W, H, grid + avgLine + bars)
}

/** 按小时的请求分布：最忙的一小时实色 */
export function hoursSvg(hours: Record<string, number>, width = 300): string {
  const W = clampW(width, 200)
  const H = 104
  const top = 6
  const bottom = 22
  const plotH = H - top - bottom
  const vals = Array.from({ length: 24 }, (_, i) => hours[String(i)] ?? 0)
  const max = Math.max(1, ...vals)
  const slot = W / 24
  const gap = Math.min(4, slot * 0.25)
  const bars = vals
    .map((v, i) => {
      const h = Math.max((v / max) * plotH, v > 0 ? 2 : 0)
      const x = i * slot + gap / 2
      const bw = slot - gap
      const track = `<rect x="${x.toFixed(1)}" y="${top}" width="${bw.toFixed(1)}" height="${plotH}" rx="2" class="track"/>`
      return `<g><title>${i}:00–${i + 1}:00 · ${v} 次请求</title>${track}<rect x="${x.toFixed(1)}" y="${(top + plotH - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${ACCENT}" ${v === max ? '' : 'class="dim"'}/></g>`
    })
    .join('')
  const labels = [0, 6, 12, 18]
    .map(i => `<text x="${(i * slot + gap / 2).toFixed(1)}" y="${H - 6}">${i}:00</text>`)
    .join('')
  return svg(W, H, bars + labels)
}

/** color 填 'track' 时用轨道底色（跟随深浅色） */
export type Segment = { name: string; value: number; color: string; note?: string }

let clipSeq = 0

/** 一条圆角堆叠条，段间留 2px 缝 */
export function stackSvg(segs: Segment[], width = 400): string {
  const W = clampW(width, 120)
  const H = 10
  const total = segs.reduce((s, x) => s + x.value, 0)
  if (total <= 0) return svg(W, H, `<rect width="${W}" height="${H}" rx="5" class="track"/>`)
  const shown = segs.filter(s => s.value / total > 0.002)
  if (shown.length === 0) return svg(W, H, `<rect width="${W}" height="${H}" rx="5" class="track"/>`)
  const shownTotal = shown.reduce((s, x) => s + x.value, 0)
  const gap = 2
  const usable = W - gap * (shown.length - 1)
  let x = 0
  const body = shown
    .map(s => {
      const w = Math.max(2, (s.value / shownTotal) * usable)
      const paint = s.color === 'track' ? 'class="track"' : `fill="${s.color}"`
      const r = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${H}" ${paint}><title>${escapeXml(s.name)} ${escapeXml(s.note ?? '')}</title></rect>`
      x += w + gap
      return r
    })
    .join('')
  const cid = `c${++clipSeq}`
  return svg(W, H, `<clipPath id="${cid}"><rect width="${W}" height="${H}" rx="5"/></clipPath><g clip-path="url(#${cid})">${body}</g>`)
}

/** 环形图：中心显示主数值与小标，段间留细缝，悬停看明细 */
export function donutSvg(
  segs: Segment[],
  size = 108,
  center?: { top: string; sub?: string },
): string {
  const S = clampW(size, 72)
  const cx = S / 2
  const cy = S / 2
  const strokeW = Math.max(10, Math.round(S * 0.16))
  const r = (S - strokeW) / 2 - 2
  const C = 2 * Math.PI * r
  const total = segs.reduce((s, x) => s + Math.max(0, x.value), 0)
  const track = `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(2)}" fill="none" stroke="var(--track)" stroke-width="${strokeW}"/>`
  let arcs = ''
  if (total > 0) {
    const shown = segs.filter(s => s.value > 0 && s.value / total > 0.002)
    const shownTotal = shown.reduce((s, x) => s + x.value, 0)
    const gap = shown.length > 1 ? 2.5 : 0
    let acc = 0
    arcs = shown
      .map(s => {
        const raw = (s.value / shownTotal) * C
        const len = shown.length > 1 ? Math.max(2, raw - gap) : C
        const rest = Math.max(0, C - len)
        const el = `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(2)}" fill="none" stroke="${s.color}" stroke-width="${strokeW}" stroke-dasharray="${len.toFixed(2)} ${rest.toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"><title>${escapeXml(s.name)}${s.note ? ' · ' + escapeXml(s.note) : ''}</title></circle>`
        acc += raw
        return el
      })
      .join('')
  }
  const label = center
    ? `<text x="${cx}" y="${(center.sub ? cy + 2 : cy + 5).toFixed(1)}" text-anchor="middle" class="ink strong" style="font-size:13px">${escapeXml(center.top)}</text>` +
      (center.sub
        ? `<text x="${cx}" y="${(cy + 15).toFixed(1)}" text-anchor="middle" style="font-size:10px">${escapeXml(center.sub)}</text>`
        : '')
    : ''
  return svg(S, S, track + arcs + label)
}

export type HeatDay = { usd: number; tokens: number; sessions: number }

/** 活跃度日历热力图：按周排布（周一到周日），按 token 平方根映射深浅，悬停看当天明细 */
export function heatmapSvg(byDay: Record<string, HeatDay>, today: string, width = 340): string {
  const W = clampW(width, 200)
  const left = 20
  const top = 18
  const cell = 11
  const gap = 3
  const step = cell + gap
  const H = top + 7 * step - gap + 4
  const weeks = Math.max(8, Math.min(26, Math.floor((W - left) / step)))
  const todayMs = Date.parse(today + 'T00:00:00Z')
  if (Number.isNaN(todayMs)) return svg(W, H, '')
  // 周一=0 .. 周日=6
  const todayDow = (new Date(todayMs).getUTCDay() + 6) % 7
  const startMs = todayMs - ((weeks - 1) * 7 + todayDow) * 86_400_000

  type Cell = { col: number; row: number; day: string; info?: HeatDay }
  const cells: Cell[] = []
  let maxTok = 0
  for (let col = 0; col < weeks; col++) {
    for (let row = 0; row < 7; row++) {
      const ms = startMs + (col * 7 + row) * 86_400_000
      if (ms > todayMs) continue
      const day = new Date(ms).toISOString().slice(0, 10)
      const info = byDay[day]
      if (info && info.tokens > maxTok) maxTok = info.tokens
      cells.push({ col, row, day, info })
    }
  }

  // 周内标签（一 / 三 / 五）
  const rowLabels = [
    [0, '一'],
    [2, '三'],
    [4, '五'],
  ]
    .map(([r, text]) => `<text x="0" y="${top + (r as number) * step + 9}" style="font-size:10px">${text}</text>`)
    .join('')

  // 顶部月份标签：每当新月份首次出现在某周，且距上一个标签至少 28px 时标出
  let lastMonth = -1
  let lastLabelX = -100
  const monthLabels: string[] = []
  for (let col = 0; col < weeks; col++) {
    const ms = startMs + col * 7 * 86_400_000
    const m = new Date(ms).getUTCMonth() + 1
    const x = left + col * step
    if (m !== lastMonth && x - lastLabelX >= 28) {
      monthLabels.push(`<text x="${x}" y="11" style="font-size:10px">${m}月</text>`)
      lastLabelX = x
    }
    lastMonth = m
  }

  const rects = cells
    .map(c => {
      const x = left + c.col * step
      const y = top + c.row * step
      const tok = c.info?.tokens ?? 0
      const tip = c.info
        ? `${c.day}\n${fmtUsd(c.info.usd)} · ${c.info.sessions} 个会话 · ${fmtTokens(c.info.tokens)} token`
        : `${c.day}\n无活动`
      if (tok <= 0 || maxTok <= 0) {
        return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5" class="track"><title>${escapeXml(tip)}</title></rect>`
      }
      const ratio = Math.sqrt(tok / maxTok)
      const op = ratio <= 0.25 ? 0.3 : ratio <= 0.5 ? 0.52 : ratio <= 0.75 ? 0.76 : 1
      return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5" fill="${ACCENT}" opacity="${op}"><title>${escapeXml(tip)}</title></rect>`
    })
    .join('')

  const actualW = left + weeks * step - gap + 2
  return svg(actualW, H, rowLabels + monthLabels.join('') + rects)
}

/** 排行行下的细进度线：轨道底色 + 实色部分（单行大量渲染，用精简样式） */
const LINE_STYLE = `<style>:root{--track:#EDEDED}@media (prefers-color-scheme:dark){:root{--track:#363636}}.track{fill:var(--track)}</style>`

export function lineSvg(fraction: number, width: number, color: string): string {
  const W = clampW(width, 60)
  const H = 4
  const w = Math.max(2, Math.min(1, Math.max(0, fraction)) * W)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="max-width:100%;height:auto">${LINE_STYLE}<rect width="${W}" height="${H}" rx="2" class="track"/><rect width="${w.toFixed(1)}" height="${H}" rx="2" fill="${color}"/></svg>`
}

/**
 * 逐请求上下文大小：面积 + 折线，最新一点加圆点；
 * 虚线为自动压缩阈值，标在右侧。纵轴以窗口大小为上限，一眼看出离压缩还有多远。
 */
export function contextTrendSvg(values: number[], window: number, compactAt: number | undefined, width = 520): string {
  const W = clampW(width, 240)
  const H = 136
  const left = 44
  const right = compactAt !== undefined ? 64 : 16
  const top = 16
  const bottom = 10
  const plotW = W - left - right
  const plotH = H - top - bottom
  const max = Math.max(window, ...values, 1)
  const y = (v: number) => top + plotH - (v / max) * plotH
  const n = values.length
  const x = (i: number) => left + (n === 1 ? plotW : (i / (n - 1)) * plotW)
  const grid = [0, 0.5, 1]
    .map(f => {
      const yy = y(max * f)
      return `<line class="grid" x1="${left}" x2="${left + plotW}" y1="${yy}" y2="${yy}" stroke-width="1"/><text x="${left - 10}" y="${yy + 4}" text-anchor="end">${fmtTokens(max * f)}</text>`
    })
    .join('')
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `${x(0).toFixed(1)},${top + plotH} ${pts} ${x(n - 1).toFixed(1)},${top + plotH}`
  const lastV = values[n - 1] ?? 0
  const compact =
    compactAt !== undefined
      ? `<line x1="${left}" x2="${left + plotW}" y1="${y(compactAt).toFixed(1)}" y2="${y(compactAt).toFixed(1)}" stroke="${ORANGE}" stroke-width="1" stroke-dasharray="3 4" opacity="0.9"/><text x="${left + plotW + 8}" y="${(y(compactAt) - 2).toFixed(1)}">压缩线</text><text x="${left + plotW + 8}" y="${(y(compactAt) + 12).toFixed(1)}" class="ink">${fmtTokens(compactAt)}</text>`
      : ''
  const hit = plotW / Math.max(n, 1)
  const hits = values
    .map(
      (v, i) =>
        `<g><title>第 ${i + 1} 次请求 · ${fmtTokens(v)}</title><rect x="${(x(i) - hit / 2).toFixed(1)}" y="${top}" width="${hit.toFixed(1)}" height="${plotH}" fill="transparent"/></g>`,
    )
    .join('')
  return svg(
    W,
    H,
    `${grid}<polygon points="${area}" fill="${ACCENT}" opacity="0.1"/><polyline points="${pts}" fill="none" stroke="${ACCENT}" stroke-width="1.8" stroke-linejoin="round"/>${compact}<circle cx="${x(n - 1).toFixed(1)}" cy="${y(lastV).toFixed(1)}" r="3.5" fill="${ACCENT}"/>${hits}`,
  )
}
