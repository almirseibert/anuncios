import { randomBytes } from 'node:crypto';
import { all, get, nowIso, run } from '../db/index.ts';
import { config } from '../config.ts';

/**
 * Link de envio de fotos pelo celular. A rota /m e isenta do basic auth --
 * digitar senha longa no celular, com o produto na mao, nao funciona na
 * pratica -- entao o token no link e que autoriza, e ele vale pouco tempo e
 * serve a um produto so.
 */

const TTL_MINUTES = 120;

interface TokenRow {
  token: string;
  product_id: string;
  expires_at: string;
}

function futureIso(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/** Apaga os tokens vencidos. Chamado a cada emissao: a tabela nunca cresce. */
export function purgeExpiredTokens() {
  run('DELETE FROM upload_tokens WHERE expires_at <= ?', nowIso());
}

/**
 * Emite (ou reaproveita) o token do produto. Reaproveitar mantem o QR Code
 * estavel: recarregar o painel nao invalida o link aberto no celular.
 */
export function issueUploadToken(productId: string) {
  purgeExpiredTokens();
  const existing = all<TokenRow>(
    'SELECT * FROM upload_tokens WHERE product_id = ? AND expires_at > ? ORDER BY expires_at DESC',
    productId, nowIso(),
  )[0];
  if (existing) return { token: existing.token, expiresAt: existing.expires_at };

  const token = randomBytes(24).toString('base64url');
  const expiresAt = futureIso(TTL_MINUTES);
  run(
    'INSERT INTO upload_tokens (token, product_id, expires_at, created_at) VALUES (?,?,?,?)',
    token, productId, expiresAt, nowIso(),
  );
  return { token, expiresAt };
}

/** Produto do token, ou undefined quando o token nao existe ou venceu. */
export function productIdForToken(token: string) {
  const row = get<TokenRow>('SELECT * FROM upload_tokens WHERE token = ?', token);
  if (!row) return undefined;
  if (row.expires_at <= nowIso()) return undefined;
  return row.product_id;
}

export function revokeUploadToken(token: string) {
  run('DELETE FROM upload_tokens WHERE token = ?', token);
}

export function uploadLink(token: string) {
  return `${config.publicUrl}/m/${token}`;
}
