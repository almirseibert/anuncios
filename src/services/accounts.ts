import { get, nowIso, run } from '../db/index.ts';
import type { ChannelAccount } from '../channels/types.ts';

interface AccountRow {
  channel: string; label: string; access_token: string | null; refresh_token: string | null;
  expires_at: string | null; meta_json: string; connected_at: string | null;
}

export function getAccount(channel: string): ChannelAccount | undefined {
  const row = get<AccountRow>('SELECT * FROM channel_accounts WHERE channel = ?', channel);
  if (!row) return undefined;
  return {
    channel: row.channel,
    label: row.label,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    meta: JSON.parse(row.meta_json) as Record<string, unknown>,
    connectedAt: row.connected_at,
  };
}

export function saveAccount(a: {
  channel: string; label?: string; accessToken?: string | null; refreshToken?: string | null;
  expiresAt?: string | null; meta?: Record<string, unknown>;
}) {
  run(
    `INSERT INTO channel_accounts (channel, label, access_token, refresh_token, expires_at, meta_json, connected_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(channel) DO UPDATE SET
       label=excluded.label, access_token=excluded.access_token, refresh_token=excluded.refresh_token,
       expires_at=excluded.expires_at, meta_json=excluded.meta_json, connected_at=excluded.connected_at`,
    a.channel, a.label ?? '', a.accessToken ?? null, a.refreshToken ?? null, a.expiresAt ?? null,
    JSON.stringify(a.meta ?? {}), nowIso(),
  );
  return getAccount(a.channel)!;
}

export function disconnectAccount(channel: string) {
  run('DELETE FROM channel_accounts WHERE channel = ?', channel);
}

export function isExpired(a: ChannelAccount | undefined, skewSeconds = 120) {
  if (!a?.expiresAt) return false;
  return Date.parse(a.expiresAt) - skewSeconds * 1000 <= Date.now();
}
