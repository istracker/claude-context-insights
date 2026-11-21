import { expect, test } from 'claude-code/testing'

import { dailySvg, dailyTokenSvg, fluidHeight, stackSvg, svgSize } from '../hooks/charts'

test('堆叠条：不同的条 clipPath id 不同，同样的数据重绘时 SVG 完全一致（不闪烁）', () => {
  const a = stackSvg([{ name: 'a', value: 1, color: '#111111' }], 200)
  const b = stackSvg([{ name: 'b', value: 1, color: '#222222' }], 300)
  const idA = /clipPath id="([^"]+)"/.exec(a)?.[1]
  const idB = /clipPath id="([^"]+)"/.exec(b)?.[1]
  expect(idA).toBeDefined()
  expect(idA).not.toBe(idB)
  expect(a).toContain(`url(#${idA})`)
  expect(stackSvg([{ name: 'a', value: 1, color: '#111111' }], 200)).toBe(a)
})

test('每日成本图：空序列不产生 NaN / Infinity 坐标', () => {
  const s = dailySvg([], 300)
  expect(s).not.toContain('NaN')
  expect(s).not.toContain('Infinity')
})

test('每日 token 柱图：铺满宽度、空序列与全零不产生 NaN，金额可关，今天的柱子画浅色', () => {
  const empty = dailyTokenSvg([], 100)
  expect(empty).not.toContain('NaN')
  expect(fluidHeight(empty)).toBe(100)
  const day = (d: string, tokens: number) => ({ day: d, usd: 1.5, tokens, req: 1, prompts: 1 })
  const zero = dailyTokenSvg([day('2026-11-20', 0), day('2026-11-21', 0)], 100)
  expect(zero).not.toContain('NaN')
  const s = dailyTokenSvg([day('2026-11-20', 1000), day('2026-11-21', 3000)], 100, false)
  expect(s).toContain('width="100%"')
  expect(s).toContain('（今天，进行中）')
  // 悬停提示用 CSS :hover 立即显示，不用系统 <title>
  expect(s).toContain('.h1:hover~.t1{visibility:visible}')
  expect(s).not.toContain('<title>')
  expect(s).toContain('opacity="0.4"')
  expect(s).not.toContain('$')
  // 不以今天结尾（如「上月」）：没有浅色柱
  expect(dailyTokenSvg([day('2026-10-30', 1000), day('2026-10-31', 3000)], 100, true, false)).not.toContain('opacity="0.4"')
})
