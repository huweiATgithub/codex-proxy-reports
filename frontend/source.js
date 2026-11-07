// Policy describes possible history loss; it is not a coverage guarantee.
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validRetention = days => days === null || (Number.isSafeInteger(days) && days > 0 && days <= 0xffffffff);

export function parseSource(source) {
  if (source == null) return null; // Reports saved before source metadata was added.
  if (!validTime(source.snapshot_at) || !validRetention(source.retention_days)) {
    throw new Error('The plugin returned invalid report source metadata.');
  }
  return source;
}

export function parsePreview(preview) {
  if (!preview?.bounds || !validTime(preview.bounds.start) || !validTime(preview.bounds.end)
    || Date.parse(preview.bounds.start) >= Date.parse(preview.bounds.end)
    || !validTime(preview.evaluated_at) || !validRetention(preview.retention_days)) {
    throw new Error('The plugin returned an invalid history preview.');
  }
  return preview;
}

export function retentionNotice(bounds, days, at) {
  if (days === null) return 'Host history retention could not be checked. Only history still available on the host can be counted.';
  if (Date.parse(bounds.start) < Date.parse(at) - days * 86400000) {
    return `This range starts outside the host’s ${days}-day history retention period. Earlier requests may have been deleted, so counts may be incomplete.`;
  }
  return '';
}
