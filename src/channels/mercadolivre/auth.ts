import { createHash, randomBytes } from 'node:crypto';
import { config } from '../../config.ts';
import { request } from '../../lib/http.ts';
import { getAccount, isExpired, saveAccount } from '../../services/accounts.ts';
import { ChannelError, type ChannelAccount } from '../types.ts';

const API = 'https://api.mercadolibre.com';
export const CHANNEL_ID = 'mercadolivre';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  user_id?: number;
  scope?: string;
}

/**
 * PKCE (RFC 7636), hoje obrigatorio no Mercado Livre: sem code_verifier a troca
 * do code pelo token falha com "code_verifier is a required parameter".
 *
 * O segredo (verifier) fica so no servidor; o que viaja pelo navegador e o
 * hash dele (challenge). Assim, quem interceptar o code na volta nao consegue
 * troca-lo por um token.
 */
export function newPkcePair() {
  const verifier = randomBytes(32).toString('base64url'); // 43 chars, dentro do limite da RFC
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** Exportado para teste: S256 do verifier em base64url, sem padding. */
export function pkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function authorizeUrl(state: string, codeChallenge: string) {
  const { clientId, redirectUri } = config.channels.mercadolivre;
  if (!clientId || !redirectUri) {
    throw new ChannelError('defina ML_CLIENT_ID e ML_REDIRECT_URI no .env antes de conectar');
  }
  const u = new URL('https://auth.mercadolivre.com.br/authorization');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

function persist(token: TokenResponse, previous?: ChannelAccount) {
  return saveAccount({
    channel: CHANNEL_ID,
    label: previous?.label ?? '',
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    meta: { ...previous?.meta, userId: token.user_id ?? previous?.meta?.userId, scope: token.scope },
  });
}

export async function exchangeCode(code: string, codeVerifier: string) {
  const { clientId, clientSecret, redirectUri } = config.channels.mercadolivre;
  const token = await request<TokenResponse>(`${API}/oauth/token`, {
    form: {
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    },
  });
  const account = persist(token);
  const me = await request<{ id: number; nickname: string }>(`${API}/users/me`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  return saveAccount({
    ...account,
    label: me.nickname,
    meta: { ...account.meta, userId: me.id, nickname: me.nickname },
  });
}

export async function refresh(account: ChannelAccount) {
  const { clientId, clientSecret } = config.channels.mercadolivre;
  if (!account.refreshToken) throw new ChannelError('conta do Mercado Livre sem refresh_token: reconecte');
  const token = await request<TokenResponse>(`${API}/oauth/token`, {
    form: {
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: account.refreshToken,
    },
  });
  return persist(token, account);
}

/** Devolve uma conta com token valido, renovando quando perto de expirar. */
export async function ensureToken(): Promise<ChannelAccount> {
  const account = getAccount(CHANNEL_ID);
  if (!account?.accessToken) {
    throw new ChannelError('Mercado Livre nao conectado: use "Conectar" na tela de canais');
  }
  if (!isExpired(account)) return account;
  return refresh(account);
}

export const ML_API = API;
