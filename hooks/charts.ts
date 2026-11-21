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
/** height：并排时拉高以对齐右侧卡片，避免左卡下半部空着 */
export function dailySvg(series: DayPoint[], width = 520, height = 180): string {
  const W = clampW(width, 240)
  const H = Math.max(110, Math.round(height))
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

/** 按内容算一个稳定的短 id（FNV-1a）：同样的数据每次重绘生成完全相同的 SVG，宿主不会换图而闪烁 */
function stableId(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

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
  // clipPath id 由内容决定：数据不变时 SVG 字符串不变（避免滚动重绘时整图被替换而闪烁）；不同的条 id 不同，互不裁切
  const cid = `c${stableId(`${W}|${body}`)}`
  return svg(W, H, `<clipPath id="${cid}"><rect width="${W}" height="${H}" rx="5"/></clipPath><g clip-path="url(#${cid})">${body}</g>`)
}



/** 排行行下的细进度线：轨道底色 + 实色部分（单行大量渲染，用精简样式） */
const LINE_STYLE = `<style>:root{--track:#EDEDED}@media (prefers-color-scheme:dark){:root{--track:#363636}}.track{fill:var(--track)}</style>`

export function lineSvg(fraction: number, width: number, color: string, height = 4): string {
  const W = clampW(width, 60)
  const H = Math.max(2, Math.round(height))
  const f = Math.min(1, Math.max(0, fraction))
  const r = H / 2
  // 为 0 时只画轨道，不留色点
  const fill = f > 0 ? `<rect width="${Math.max(H, f * W).toFixed(1)}" height="${H}" rx="${r}" fill="${color}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="max-width:100%;height:auto">${LINE_STYLE}<rect width="${W}" height="${H}" rx="${r}" class="track"/>${fill}</svg>`
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

/**
 * 横向铺满容器的图：宽度写 100%、按 viewBox 拉伸（preserveAspectRatio="none"），高度固定。
 * 插件只能按字符列估算像素宽度，估小右边留空、估大会把卡片撑出面板；拉伸后两种问题都没有。
 * 只适合没有文字的图（文字会被横向拉变形），日期等标注放在图外用文字元素画。
 */
function fluidSvg(w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" data-fluid="1" width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block">${STYLE}${body}</svg>`
}
/** 铺满图的高度（像素）；不是铺满图时为 undefined */
export function fluidHeight(source: string): number | undefined {
  if (!source.includes('data-fluid="1"')) return undefined
  const m = /\sheight="(\d+(?:\.\d+)?)"/.exec(source)
  return m ? Number(m[1]) : undefined
}

/**
 * 按百分比布局、横向铺满容器的图（不用 viewBox，不拉伸）：x、宽度写百分比，y、高度写像素，
 * 文字不会被拉变形，所以可以在图里画悬停提示。
 */
function fluidPctSvg(h: number, extraStyle: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" data-fluid="1" width="100%" height="${h}" style="display:block;overflow:visible">${STYLE}<style>${extraStyle}</style>${body}</svg>`
}

/** 悬停提示框的大致宽度：中文按 12px、其余按 7px，两侧各留 8px */
function tipWidth(lines: string[]): number {
  const w = (t: string) => [...t].reduce((a, ch) => a + (/[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 12 : 7), 0)
  return Math.max(...lines.map(w)) + 16
}

/**
 * 每日 token：一天一根柱，日均画虚线。今天还没过完（endsToday），柱子画浅色，避免看成「跳水」。
 * 横向铺满卡片；日期标注由调用方在图下用文字画。
 * 悬停柱子立即显示当天明细（CSS :hover，不用 <title>：系统提示要停留约一秒才出现）。
 */
export function dailyTokenSvg(series: DayPoint[], height = 100, showMoney = true, endsToday = true): string {
  const n = series.length
  const H = Math.max(60, Math.round(height))
  if (n === 0) return fluidPctSvg(H, '', '')
  const top = 4
  const base = H - 1
  const plotH = base - top
  const max = Math.max(1, ...series.map(s => s.tokens)) * 1.08
  const avg = series.reduce((a, s) => a + s.tokens, 0) / n
  const y = (v: number) => base - (v / max) * plotH
  const slot = 100 / n
  const pc = (v: number) => `${v.toFixed(3)}%`
  // 悬停区（每天一整列）在最下层接住指针；柱子不接指针；提示框在最上层，按序号与悬停区配对显示
  const hits = series
    .map((_, i) => `<rect class="h${i}" x="${pc(i * slot)}" y="0" width="${pc(slot)}" height="${H}" fill="transparent"/>`)
    .join('')
  const bars = series
    .map((s, i) => {
      const isToday = endsToday && i === n - 1
      const h = Math.max((s.tokens / max) * plotH, s.tokens > 0 ? 2 : 0)
      return `<rect class="b b${i}" x="${pc(i * slot + slot * 0.2)}" y="${(base - h).toFixed(1)}" width="${pc(slot * 0.6)}" height="${h.toFixed(1)}" fill="${ACCENT}"${isToday ? ' opacity="0.4"' : ''}/>`
    })
    .join('')
  const avgLine =
    avg > 0
      ? `<line x1="0" x2="100%" y1="${y(avg).toFixed(1)}" y2="${y(avg).toFixed(1)}" stroke="${GREY}" stroke-width="1" stroke-dasharray="3 3" opacity="0.8" pointer-events="none"/>`
      : ''
  const axis = `<line class="grid" x1="0" x2="100%" y1="${base}" y2="${base}" stroke-width="1" pointer-events="none"/>`
  const tips = series
    .map((s, i) => {
      const isToday = endsToday && i === n - 1
      const l1 = isToday ? `${s.day}（今天，进行中）` : s.day
      const l2 = `${fmtTokens(s.tokens)} token · ${s.prompts} 次提问${showMoney ? ` · ≈ ${fmtUsd(s.usd)}` : ''}`
      const w = tipWidth([l1, l2])
      // 左半边的柱子提示框向右展开，右半边的向左展开，不出图
      const isRight = i >= n / 2
      const anchor = pc(isRight ? i * slot : (i + 1) * slot)
      const x0 = isRight ? -w - 4 : 4
      return (
        `<svg class="t t${i}" x="${anchor}" y="2" overflow="visible">` +
        `<rect x="${x0}" y="0" width="${w}" height="38" rx="4" class="tipbg"/>` +
        `<text x="${x0 + 8}" y="15" class="ink">${escapeXml(l1)}</text>` +
        `<text x="${x0 + 8}" y="31" class="ink strong">${escapeXml(l2)}</text></svg>`
      )
    })
    .join('')
  const css =
    '.b,.t{pointer-events:none}.t{visibility:hidden}' +
    '.tipbg{fill:#FFFFFF;stroke:#D9D9D9}@media (prefers-color-scheme:dark){.tipbg{fill:#2A2A2A;stroke:#444444}}' +
    series.map((_, i) => `.h${i}:hover~.t${i}{visibility:visible}.h${i}:hover~.b${i}{opacity:.75}`).join('')
  return fluidPctSvg(H, css, hits + axis + bars + avgLine + tips)
}


/** 构成表上方的细分段条（与 /context 的用量条同风格）：4px 高，横向铺满，段间留缝 */
export function thinStackSvg(segs: { value: number; color: string }[]): string {
  const W = 1000
  const total = segs.reduce((a, s) => a + Math.max(0, s.value), 0)
  let x = 0
  const body = segs
    .filter(s => s.value > 0 && total > 0)
    .map(s => {
      const w = (s.value / total) * W
      const el = `<rect x="${x.toFixed(1)}" width="${Math.max(2, w - 3).toFixed(1)}" height="4" fill="${s.color}"/>`
      x += w
      return el
    })
    .join('')
  return fluidSvg(W, 4, `<rect width="${W}" height="4" class="track"/>${body}`)
}

/** 额度进度条：6px 高，横向铺满所在列；非当前账号的旧读数把填充调淡 */
export function fluidBarSvg(fraction: number, color: string, isStale = false): string {
  const W = 1000
  const f = Math.min(1, Math.max(0, fraction))
  const fill = f > 0 ? `<rect width="${Math.max(6, f * W).toFixed(1)}" height="6" fill="${color}"${isStale ? ' opacity="0.55"' : ''}/>` : ''
  return fluidSvg(W, 6, `<rect width="${W}" height="6" class="track"/>${fill}`)
}
