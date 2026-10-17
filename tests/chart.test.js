import assert from 'node:assert/strict';
import test from 'node:test';
import { chartGeometry, colorForChoice, labelPositions, sectorPath, selectChoices } from '../frontend/chart.js';

const group = (model, requests, is_subagent = false, reasoning_effort = 'high') => ({ model, requests, is_subagent, reasoning_effort });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, actual + ' != ' + expected);

test('combine Subagent flags before ranking; exclude an exactly 5% choice', () => {
  const chart = selectChoices([group('A', 45), group('A', 45, true), group('B', 6), group('C', 5)]);
  assert.equal(chart.total, 101);
  assert.deepEqual(chart.choices.map(choice => [choice.model, choice.requests, choice.subagents]), [['A', 90, 45], ['B', 6, 0], ['Others', 5, 0]]);
  const exact = selectChoices([group('A', 94), group('B', 5), group('C', 1, true)]);
  assert.deepEqual(exact.choices.map(choice => [choice.model, choice.requests, choice.subagents]), [['A', 94, 0], ['Others', 6, 1]]);
});

test('tie order uses model then effort; the sixth qualifying choice joins Others with its Subagents', () => {
  const chart = selectChoices([
    group('z', 10, true), group('a', 10, false, 'max'), group('b', 10), group('d', 10),
    group('c', 10, true), group('a', 10, true, 'high'), group('small', 1, true),
  ]);
  assert.deepEqual(chart.choices.map(choice => [choice.model, choice.effort]), [
    ['a', 'high'], ['a', 'max'], ['b', 'high'], ['c', 'high'], ['d', 'high'], ['Others', ''],
  ]);
  assert.equal(chart.choices.at(-1).requests, 11);
  assert.equal(chart.choices.at(-1).subagents, 11);
  assert.equal(chart.choices.reduce((sum, choice) => sum + choice.requests, 0), chart.total);
});

test('threshold comparison stays exact at large supported counts and literal Others is still a model', () => {
  const total = Number.MAX_SAFE_INTEGER;
  const threshold = Math.floor(total / 20);
  const chart = selectChoices([group('large', total - threshold), group('Others', threshold)]);
  assert.equal(chart.choices[1].others, true);
  const above = selectChoices([group('large', total - threshold - 1), group('Others', threshold + 1)]);
  assert.equal(above.choices[1].model, 'Others');
  assert.equal(above.choices[1].others, false);
  assert.throws(() => selectChoices([group('a', total), group('b', 1)]), /supported range/);
});

test('overlays end at the clockwise parent edge without changing the parent angle', () => {
  const chart = selectChoices([group('A', 30), group('A', 20, true), group('B', 25, true), group('C', 25)]);
  const sectors = chartGeometry(chart);
  close(sectors[0].start, 0);
  close(sectors[0].end, 180);
  close(sectors[0].overlayStart, 108);
  close(sectors[0].overlayEnd, 180);
  close(sectors[1].start, 180);
  close(sectors[1].end, 270);
  close(sectors[1].overlayStart, sectors[1].start);
  close(sectors[2].overlayStart, sectors[2].end);
  close(sectors.at(-1).end, 360);
  assert.ok(sectors[0].x > 0, 'the first sector proceeds clockwise from 12 o’clock');
});

test('single-choice circles render as two arcs; no eligible requests yield no sectors', () => {
  const chart = selectChoices([group('gpt', 10, true, 'unspecified')]);
  const [sector] = chartGeometry(chart);
  assert.equal((sectorPath(0.94, sector.start, sector.end).match(/ A /g) || []).length, 2);
  assert.equal(sector.overlayStart, 0);
  assert.deepEqual(selectChoices([]), { total: 0, choices: [] });
  assert.deepEqual(chartGeometry(selectChoices([])), []);
});

test('leaders keep each side’s label order and spacing inside the reference bounds', () => {
  const sectors = [
    { side: 1, y: -.1 }, { side: 1, y: 0 }, { side: 1, y: .1 }, { side: 1, y: .2 }, { side: 1, y: .3 },
    { side: -1, y: -.8 },
  ];
  const positions = labelPositions(sectors);
  for (let index = 0; index < 4; index++) assert.ok(positions.get(index + 1) - positions.get(index) >= .48 - 1e-9);
  for (const position of positions.values()) assert.ok(position >= -1.15 && position <= 1.15);
  assert.equal(colorForChoice('A', 'high'), colorForChoice('A', 'high'));
  assert.notEqual(colorForChoice('A', 'high'), colorForChoice('A', 'max'));
});
