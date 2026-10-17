const NS = 'http://www.w3.org/2000/svg';
const RADIUS = 0.94;
const OVERLAY_RADIUS = RADIUS * 1.06;
let nextChartId = 0;

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const addCount = (left, right) => {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error('The report request count exceeds the supported range.');
  return result;
};

// Keep the integer counts until display; an exactly 5% share never qualifies.
export function selectChoices(groups) {
  const combined = new Map();
  let total = 0;
  for (const group of groups) {
    if (!Number.isSafeInteger(group.requests) || group.requests < 0 || typeof group.model !== 'string'
      || typeof group.reasoning_effort !== 'string' || typeof group.is_subagent !== 'boolean') {
      throw new Error('The report contains an invalid request group.');
    }
    if (!group.requests) continue;
    const key = JSON.stringify([group.model, group.reasoning_effort]);
    const choice = combined.get(key) || { model: group.model, effort: group.reasoning_effort, requests: 0, subagents: 0, others: false };
    choice.requests = addCount(choice.requests, group.requests);
    if (group.is_subagent) choice.subagents = addCount(choice.subagents, group.requests);
    combined.set(key, choice);
    total = addCount(total, group.requests);
  }
  const ranked = [...combined.values()].sort((left, right) => right.requests - left.requests
    || compareText(left.model, right.model) || compareText(left.effort, right.effort));
  // BigInt keeps this comparison exact even near the safe-integer limit.
  const selected = ranked.filter(choice => BigInt(choice.requests) * 20n > BigInt(total)).slice(0, 5);
  const chosen = new Set(selected);
  const rest = ranked.filter(choice => !chosen.has(choice));
  if (rest.length) selected.push({
    model: 'Others', effort: '', others: true,
    requests: rest.reduce((sum, choice) => addCount(sum, choice.requests), 0),
    subagents: rest.reduce((sum, choice) => addCount(sum, choice.subagents), 0),
  });
  return { total, choices: selected };
}

export function chartGeometry(chart) {
  let angle = 0;
  return chart.choices.map(choice => {
    const extent = 360 * choice.requests / chart.total;
    const end = angle + extent;
    const middle = (angle + end) / 2;
    const radians = middle * Math.PI / 180;
    const result = {
      ...choice, start: angle, end,
      overlayStart: end - 360 * choice.subagents / chart.total,
      overlayEnd: end,
      x: Math.sin(radians), y: -Math.cos(radians),
      side: Math.sin(radians) >= 0 ? 1 : -1,
    };
    angle = end;
    return result;
  });
}

export function labelPositions(sectors) {
  const positions = new Map();
  for (const side of [-1, 1]) {
    const entries = sectors.map((sector, index) => ({ ...sector, index }))
      .filter(sector => sector.side === side).sort((left, right) => left.y - right.y);
    const anchors = [];
    for (const entry of entries) {
      const desired = Math.max(-1.15, Math.min(1.15, entry.y));
      anchors.push(anchors.length ? Math.max(desired, anchors.at(-1) + 0.48) : desired);
    }
    const shift = Math.max(0, (anchors.at(-1) ?? 0) - 1.15);
    entries.forEach((entry, index) => positions.set(entry.index, anchors[index] - shift));
  }
  return positions;
}

export function colorForChoice(model, effort) {
  let hash = 2166136261;
  for (const character of JSON.stringify([model, effort])) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return 'hsl(' + (hash / 2 ** 32 * 360).toFixed(2) + ' 47% 66%)';
}

const point = (radius, degrees) => {
  const angle = degrees * Math.PI / 180;
  return [radius * Math.sin(angle), -radius * Math.cos(angle)];
};
const coordinates = values => values.map(value => Number(value.toFixed(7))).join(' ');

export function sectorPath(radius, start, end) {
  const from = point(radius, start);
  const to = point(radius, end);
  if (end - start >= 359.9999999) {
    const opposite = point(radius, start + 180);
    return 'M 0 0 L ' + coordinates(from) + ' A ' + radius + ' ' + radius + ' 0 1 1 ' + coordinates(opposite) + ' A ' + radius + ' ' + radius + ' 0 1 1 ' + coordinates(from) + ' Z';
  }
  return 'M 0 0 L ' + coordinates(from) + ' A ' + radius + ' ' + radius + ' 0 ' + (end - start > 180 ? 1 : 0) + ' 1 ' + coordinates(to) + ' Z';
}

function svgElement(name, attributes = {}, content) {
  const element = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (content !== undefined) element.textContent = content;
  return element;
}

function addGradient(defs, id, stops) {
  const gradient = svgElement('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: -OVERLAY_RADIUS, y1: -OVERLAY_RADIUS, x2: OVERLAY_RADIUS, y2: OVERLAY_RADIUS });
  for (const [offset, color, opacity] of stops) gradient.append(svgElement('stop', { offset, 'stop-color': color, 'stop-opacity': opacity }));
  defs.append(gradient);
}

function drawOverlay(svg, defs, sector, color, id) {
  if (!sector.subagents) return;
  const path = sectorPath(OVERLAY_RADIUS, sector.overlayStart, sector.overlayEnd);
  const shadowScale = Math.min(1, (sector.overlayEnd - sector.overlayStart) / 4);
  for (const [x, y, width, opacity] of [[0.005, 0.012, 0.022, 0.045], [0.003, 0.007, 0.01, 0.065]]) {
    svg.append(svgElement('path', {
      d: path, transform: 'translate(' + x + ' ' + y + ')', fill: 'none', stroke: 'var(--chart-shadow)',
      'stroke-width': width * shadowScale, opacity,
    }));
  }
  const clip = svgElement('clipPath', { id: id + '-clip' });
  clip.append(svgElement('path', { d: path }));
  defs.append(clip);
  // The surface uses the parent color; only the narrow bevel receives stronger light.
  addGradient(defs, id + '-surface', [[0, color, 1], [1, color, 1]]);
  addGradient(defs, id + '-lighting', [[0, '#000', 0.04], [1, '#000', 0.14]]);
  addGradient(defs, id + '-bevel', [[0, '#fff', 0.55], [0.5, '#fff', 0], [1, '#000', 0.18]]);
  const overlay = svgElement('g', { opacity: 0.42, 'clip-path': 'url(#' + id + '-clip)', 'data-region': 'subagent' });
  overlay.append(svgElement('title', {}, 'Subagent'));
  overlay.append(svgElement('path', { d: path, fill: 'url(#' + id + '-surface)' }));
  overlay.append(svgElement('path', { d: path, fill: 'url(#' + id + '-lighting)' }));
  const bevelWidth = Math.min(0.012, (sector.overlayEnd - sector.overlayStart) * Math.PI / 180 * 0.06);
  overlay.append(svgElement('path', { d: path, fill: 'none', stroke: 'url(#' + id + '-bevel)', 'stroke-width': bevelWidth * 2 }));
  svg.append(overlay);
}

export function renderChart(keyName, chart) {
  if (!chart.total) return null;
  const id = 'usage-chart-' + (++nextChartId);
  const svg = svgElement('svg', {
    viewBox: '-2.24 -1.46 4.48 2.92', role: 'img', 'aria-labelledby': id + '-title ' + id + '-description',
    class: 'usage-chart', preserveAspectRatio: 'xMidYMid meet',
  });
  svg.append(svgElement('title', { id: id + '-title' }, keyName + ': model usage distribution'));
  svg.append(svgElement('desc', { id: id + '-description' }, 'Each sector shows its share of this Key’s retained requests. The translucent raised region marks Subagent requests within that sector.'));
  const defs = svgElement('defs');
  svg.append(defs);
  for (const [radius, opacity] of [[0.978, 0.012], [0.967, 0.018], [0.956, 0.025]]) {
    svg.append(svgElement('circle', { cx: 0.008, cy: 0.021, r: radius, fill: 'var(--chart-shadow)', opacity }));
  }
  const sectors = chartGeometry(chart);
  const positions = labelPositions(sectors);
  // Draw separators beneath every overlay, so they do not cut through its raised edge.
  for (const sector of sectors) {
    const color = sector.others ? 'var(--chart-others)' : colorForChoice(sector.model, sector.effort);
    const base = svgElement('path', {
      d: sectorPath(RADIUS, sector.start, sector.end), fill: color, stroke: '#fff', 'stroke-width': 0.006,
      'data-region': 'model',
    });
    const effort = sector.effort === 'unspecified' ? '未记录' : sector.effort;
    base.append(svgElement('title', {}, sector.model + (effort ? ' / ' + effort : '') + ': ' + sector.requests.toLocaleString() + ' requests · ' + (sector.requests / chart.total * 100).toFixed(2) + '%'));
    svg.append(base);
  }
  sectors.forEach((sector, index) => {
    const color = sector.others ? 'var(--chart-others)' : colorForChoice(sector.model, sector.effort);
    drawOverlay(svg, defs, sector, color, id + '-' + index);
  });
  sectors.forEach((sector, index) => {
    const y = positions.get(index);
    const side = sector.side;
    svg.append(svgElement('polyline', {
      points: coordinates([sector.x * 1.03, sector.y * 1.03]) + ' ' + (side * 1.10) + ',' + y + ' ' + (side * 1.22) + ',' + y,
      fill: 'none', class: 'chart-leader', 'stroke-width': 0.006,
    }));
    const anchor = side > 0 ? 'start' : 'end';
    const visibleModel = [...sector.model].length > 19 ? [...sector.model].slice(0, 17).join('') + '…' : sector.model;
    const label = svgElement('text', { x: side * 1.27, y: y - 0.07, 'text-anchor': anchor, class: 'chart-label' }, visibleModel);
    label.append(svgElement('title', {}, sector.model));
    svg.append(label);
    const effort = sector.effort === 'unspecified' ? '未记录' : sector.effort;
    svg.append(svgElement('text', {
      x: side * 1.27, y: y + 0.07, 'text-anchor': anchor, class: 'chart-detail',
    }, (effort ? effort + ' · ' : '') + (sector.requests / chart.total * 100).toFixed(2) + '%'));
  });
  return svg;
}
