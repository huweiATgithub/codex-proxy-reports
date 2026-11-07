import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePreview, parseSource, retentionNotice } from '../frontend/source.js';

const at = '2026-11-07T12:00:00Z';
const bounds = { start: '2026-10-07T12:00:00Z', end: at };

test('retention hints warn about possible loss without claiming complete coverage', () => {
  assert.equal(retentionNotice(bounds, 31, at), '');
  assert.match(retentionNotice({ ...bounds, start: '2026-10-07T11:59:59.999Z' }, 31, at), /31-day.*may have been deleted.*may be incomplete/);
  assert.match(retentionNotice(bounds, null, at), /could not be checked/);
  // Compare instants, including an offset on a daylight-saving boundary.
  assert.equal(retentionNotice({ start: '2026-11-01T00:00:00-04:00' }, 1, '2026-11-02T04:00:00Z'), '');
  assert.match(retentionNotice({ start: '2026-11-01T00:00:00-04:00' }, 1, '2026-11-02T05:00:00Z'), /may be incomplete/);
});

test('old reports have no inferred snapshot, while malformed new metadata is rejected', () => {
  assert.equal(parseSource(undefined), null);
  assert.equal(parseSource(null), null);
  assert.deepEqual(parseSource({ snapshot_at: at, retention_days: null }), { snapshot_at: at, retention_days: null });
  for (const source of [{ snapshot_at: 'bad', retention_days: 31 }, { snapshot_at: at }, { snapshot_at: at, retention_days: 0 }, { snapshot_at: at, retention_days: '31' }]) {
    assert.throws(() => parseSource(source), /invalid report source/);
  }
});

test('preview requires a valid resolved interval and explicit retention availability', () => {
  const preview = { bounds, evaluated_at: at, retention_days: 31 };
  assert.deepEqual(parsePreview(preview), preview);
  assert.throws(() => parsePreview({ ...preview, bounds: { start: at, end: at } }), /invalid history preview/);
  assert.throws(() => parsePreview({ ...preview, retention_days: undefined }), /invalid history preview/);
});
