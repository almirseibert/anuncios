import { ChannelError } from '../channels/types.ts';

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
}

/** fetch com timeout, query string e erro normalizado em ChannelError. */
export async function request<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
  const target = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== '') target.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  }

  const signal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  let res: Response;
  try {
    res = await fetch(target, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, signal });
  } catch (err) {
    throw new ChannelError(`falha de rede ao chamar ${target.host}: ${(err as Error).message}`);
  }

  const text = await res.text();
  const parsed = text ? safeJson(text) : undefined;
  if (!res.ok) {
    throw new ChannelError(`${target.host} respondeu ${res.status}: ${summarize(parsed, text)}`, parsed ?? text);
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function summarize(parsed: unknown, raw: string) {
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    // Google aninha a mensagem em { error: { message } }.
    const nested = (o.error as { message?: unknown } | undefined)?.message;
    const msg = o.message ?? o.error_description ?? nested ?? o.error ?? o.detail;
    if (typeof msg === 'string') {
      const cause = Array.isArray(o.cause) ? ` (${o.cause.map((c) => JSON.stringify(c)).join('; ')})` : '';
      return msg + cause;
    }
  }
  return raw.slice(0, 500);
}

export function xmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
