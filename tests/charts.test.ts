import { expect, test } from 'claude-code/testing'

import { dailySvg, donutSvg, stackSvg, svgSize } from '../hooks/charts'

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
