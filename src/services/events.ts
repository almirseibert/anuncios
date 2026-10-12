import { all, nowIso, run } from '../db/index.ts';

export type Level = 'info' | 'warn' | 'error';

export function logEvent(
  level: Level,
  message: string,
  opts: { productId?: string; channel?: string; data?: unknown } = {},
) {
  run(
    'INSERT INTO events (product_id, channel, level, message, data_json, created_at) VALUES (?,?,?,?,?,?)',
    opts.productId ?? null, opts.channel ?? null, level, message,
    opts.data === undefined ? null : JSON.stringify(opts.data), nowIso(),
  );
}

export function recentEvents(limit = 100) {
  return all('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit);
}
