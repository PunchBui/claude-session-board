const SVG_NS = 'http://www.w3.org/2000/svg'

const SHAPES = {
  star: [['polygon', { points: '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2' }]],
  bell: [['path', { d: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9' }], ['path', { d: 'M10.3 21a1.94 1.94 0 0 0 3.4 0' }]],
  'bell-off': [['path', { d: 'M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5' }], ['path', { d: 'M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7' }], ['path', { d: 'M10.3 21a1.94 1.94 0 0 0 3.4 0' }], ['path', { d: 'm2 2 20 20' }]],
  megaphone: [['path', { d: 'm3 11 18-5v12L3 14v-3z' }], ['path', { d: 'M11.6 16.8a3 3 0 1 1-5.8-1.6' }]],
  zap: [['polygon', { points: '13 2 3 14 12 14 11 22 21 10 12 10 13 2' }]],
  clock: [['circle', { cx: 12, cy: 12, r: 10 }], ['polyline', { points: '12 6 12 12 16 14' }]],
  'arrow-up': [['path', { d: 'M12 19V5' }], ['path', { d: 'm5 12 7-7 7 7' }]],
  square: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }]],
  x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
  'arrow-up-right': [['path', { d: 'M7 7h10v10' }], ['path', { d: 'M7 17 17 7' }]],
  'help-circle': [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M9.09 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3' }], ['path', { d: 'M12 17h.01' }]],
  'pause-circle': [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M10 15V9' }], ['path', { d: 'M14 15V9' }]],
  'octagon-x': [['path', { d: 'M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86L7.86 2z' }], ['path', { d: 'm15 9-6 6' }], ['path', { d: 'm9 9 6 6' }]],
  'triangle-alert': [['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }], ['path', { d: 'M12 9v4' }], ['path', { d: 'M12 17h.01' }]],
  'check-circle': [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'm9 12 2 2 4-4' }]],
  'x-circle': [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'm15 9-6 6' }], ['path', { d: 'm9 9 6 6' }]],
  'corner-down-right': [['path', { d: 'm15 10 5 5-5 5' }], ['path', { d: 'M4 4v7a4 4 0 0 0 4 4h12' }]],
  'git-branch': [['line', { x1: 6, x2: 6, y1: 3, y2: 15 }], ['circle', { cx: 18, cy: 6, r: 3 }], ['circle', { cx: 6, cy: 18, r: 3 }], ['path', { d: 'M18 9a9 9 0 0 1-9 9' }]],
  maximize: [['path', { d: 'M8 3H5a2 2 0 0 0-2 2v3' }], ['path', { d: 'M21 8V5a2 2 0 0 0-2-2h-3' }], ['path', { d: 'M3 16v3a2 2 0 0 0 2 2h3' }], ['path', { d: 'M16 21h3a2 2 0 0 0 2-2v-3' }]],
  minimize: [['path', { d: 'M8 3v3a2 2 0 0 1-2 2H3' }], ['path', { d: 'M21 8h-3a2 2 0 0 1-2-2V3' }], ['path', { d: 'M3 16h3a2 2 0 0 1 2 2v3' }], ['path', { d: 'M16 21v-3a2 2 0 0 1 2-2h3' }]],
  copy: [['rect', { x: 8, y: 8, width: 14, height: 14, rx: 2 }], ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }]],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  'volume-2': [['polygon', { points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5' }], ['path', { d: 'M15.54 8.46a5 5 0 0 1 0 7.07' }], ['path', { d: 'M19.07 4.93a10 10 0 0 1 0 14.14' }]],
  'volume-x': [['polygon', { points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5' }], ['path', { d: 'm22 9-6 6' }], ['path', { d: 'm16 9 6 6' }]],
  terminal: [['polyline', { points: '4 17 10 11 4 5' }], ['line', { x1: 12, x2: 20, y1: 19, y2: 19 }]],
  'arrow-down': [['path', { d: 'M12 5v14' }], ['path', { d: 'm19 12-7 7-7-7' }]],
  asterisk: [['path', { d: 'M12 3v18' }], ['path', { d: 'm4.2 7.5 15.6 9' }], ['path', { d: 'm4.2 16.5 15.6-9' }]],
}

export function icon(name, { size = 16, strokeWidth = 2, fill = false, className = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', fill ? 'currentColor' : 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', String(strokeWidth))
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', `icon${className ? ` ${className}` : ''}`)
  for (const [tag, attrs] of SHAPES[name] ?? []) {
    const node = document.createElementNS(SVG_NS, tag)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
    svg.append(node)
  }
  return svg
}

export const hasIcon = (name) => name in SHAPES
