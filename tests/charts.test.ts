import { expect, test } from 'claude-code/testing'

import { dailySvg, donutSvg, heatmapSvg, stackSvg, svgSize } from '../hooks/charts'
import { buildHeatMap, mergeSessions } from '../hooks/insights'
import { emptyAgg } from '../hooks/scan'

test('环形图：按占比画弧、中心标数值、零值与空数据只画轨道', () => {
  const s = donutSvg(
    [
      { name: '缓存写入', value: 3, color: '#111111', note: '$3' },
      { name: '输出', value: 1, color: '#222222' },
      { name: '输入', value: 0, color: '#ABCDEF' },
    ],
    96,
    { top: '$4.00', sub: '合计' },
  )
  expect(svgSize(s)).toEqual({ width: 96, height: 96 })
  // 两段有值的弧 + 一圈轨道；零值段不画
  expect((s.match(/stroke-dasharray/g) ?? []).length).toBe(2)
  expect(s).toContain('#111111')
  expect(s).not.toContain('#ABCDEF')
  expect(s).toContain('$4.00')
  expect(s).toContain('合计')
  expect(s).toContain('缓存写入 · $3')
  const empty = donutSvg([{ name: 'x', value: 0, color: '#111111' }], 96)
  expect((empty.match(/stroke-dasharray/g) ?? []).length).toBe(0)
})

test('堆叠条：每次生成唯一 clipPath id，同页多条不会互相裁切', () => {
  const a = stackSvg([{ name: 'a', value: 1, color: '#111111' }], 200)
  const b = stackSvg([{ name: 'b', value: 1, color: '#222222' }], 300)
  const idA = /clipPath id="([^"]+)"/.exec(a)?.[1]
  const idB = /clipPath id="([^"]+)"/.exec(b)?.[1]
  expect(idA).toBeDefined()
  expect(idA).not.toBe(idB)
  expect(a).toContain(`url(#${idA})`)
})

test('每日成本图：空序列不产生 NaN / Infinity 坐标', () => {
  const s = dailySvg([], 300)
  expect(s).not.toContain('NaN')
  expect(s).not.toContain('Infinity')
})

test('活跃度热力图：今天之后不画格、无活动用轨道色、按宽度决定周数', () => {
  const s = heatmapSvg({ '2026-11-20': { usd: 1, tokens: 1000, sessions: 2 } }, '2026-11-20', 340)
  expect(s).not.toContain('NaN')
  // 当天有活动：实色格 + 明细提示
  expect(s).toContain('2026-11-20\n$1.00 · 2 个会话 · 1.0k token')
  // 今天之后的日期不会出现
  expect(s).not.toContain('2026-11-21')
  // 无活动的日子用轨道色
  expect(s).toContain('无活动')
  // 窄宽度时至少 8 周
  const narrow = heatmapSvg({}, '2026-11-20', 120)
  expect(svgSize(narrow).width).toBeGreaterThanOrEqual(20 + 8 * 14 - 3)
  // 非法日期安全返回
  expect(heatmapSvg({}, 'bad', 300)).not.toContain('NaN')
})

test('活跃度汇总：按天累加、近 30 天活跃天数与连续活跃天数（今天未活动时从昨天算起）', () => {
  const mk = (id: string, days: string[]) => {
    const a = emptyAgg(id, `/p/${id}.jsonl`, false)
    a.weight = 100
    a.costUsd = 1
    a.costAtWeight = 100
    a.lastAt = 1
    for (const k of days) {
      a.days[k] = { in: 100, out: 0, cr: 0, cw: 0, cw1h: 0, req: 1, prompts: 1, models: { m: 1 }, tools: {}, skills: {}, programs: {}, hours: {} }
    }
    return a
  }
  const sessions = mergeSessions([mk('a', ['2026-11-17', '2026-11-18', '2026-11-19']), mk('b', ['2026-11-19', '2026-10-01'])])
  const h = buildHeatMap(sessions, '2026-11-20')
  expect(h.byDay['2026-11-19']?.sessions).toBe(2)
  expect(h.byDay['2026-11-19']?.tokens).toBe(200)
  // 近 30 天：11-17、11-18、11-19（10-01 超出 30 天）
  expect(h.active30).toBe(3)
  // 今天没活动，从昨天往前连续 3 天
  expect(h.streak).toBe(3)
})
