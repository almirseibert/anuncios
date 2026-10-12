import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'anuncios-pkce-'));
process.env.DATA_DIR = sandbox;
process.env.UPLOADS_DIR = join(sandbox, 'uploads');
process.env.DB_FILE = join(sandbox, 'test.db');
process.env.ML_CLIENT_ID = 'app-de-teste';
process.env.ML_REDIRECT_URI = 'https://exemplo.easypanel.host/oauth/mercadolivre/callback';

const { pkceChallenge, newPkcePair, authorizeUrl } = await import('../src/channels/mercadolivre/auth.ts');

after(() => rmSync(sandbox, { recursive: true, force: true }));

test('pkceChallenge bate com o vetor de teste da RFC 7636', () => {
  // Apendice B da RFC: verifier conhecido -> challenge conhecido.
  assert.equal(
    pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('o verifier gerado respeita o formato da RFC (43-128 chars, base64url)', () => {
  for (let i = 0; i < 20; i++) {
    const { verifier, challenge } = newPkcePair();
    assert.ok(verifier.length >= 43 && verifier.length <= 128, `tamanho ${verifier.length}`);
    assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
    assert.equal(challenge, pkceChallenge(verifier));
  }
});

test('dois pedidos nunca compartilham o mesmo verifier', () => {
  const vistos = new Set(Array.from({ length: 50 }, () => newPkcePair().verifier));
  assert.equal(vistos.size, 50);
});

test('a URL de autorizacao leva o challenge e o metodo S256, nunca o verifier', () => {
  const { verifier, challenge } = newPkcePair();
  const url = new URL(authorizeUrl('estado-123', challenge));

  assert.equal(url.searchParams.get('code_challenge'), challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'estado-123');
  assert.equal(url.searchParams.get('response_type'), 'code');
  // O segredo nao pode viajar pelo navegador em hipotese nenhuma.
  assert.equal(url.toString().includes(verifier), false);
});

test('a troca do code envia o code_verifier (era isto que o ML recusava)', async () => {
  process.env.ML_CLIENT_SECRET = 'secret-de-teste';
  const { verifier, challenge } = newPkcePair();
  const chamadas: Array<{ url: string; body: string }> = [];
  const fetchOriginal = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    chamadas.push({ url, body: String(init?.body ?? '') });
    const corpo = url.includes('/oauth/token')
      ? { access_token: 'TOKEN', refresh_token: 'REFRESH', expires_in: 21600, user_id: 7 }
      : { id: 7, nickname: 'VENDEDOR_TESTE' };
    return new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const { exchangeCode } = await import('../src/channels/mercadolivre/auth.ts');
    const conta = await exchangeCode('TG-code-de-teste', verifier);
    assert.equal(conta.label, 'VENDEDOR_TESTE');
  } finally {
    globalThis.fetch = fetchOriginal;
  }

  const token = chamadas.find((c) => c.url.includes('/oauth/token'));
  assert.ok(token, 'deveria ter chamado /oauth/token');
  const enviado = new URLSearchParams(token.body);
  assert.equal(enviado.get('code_verifier'), verifier);
  assert.equal(enviado.get('grant_type'), 'authorization_code');
  assert.equal(enviado.get('code'), 'TG-code-de-teste');
  // o verifier enviado tem de corresponder ao challenge que foi para o navegador
  assert.equal(pkceChallenge(enviado.get('code_verifier')!), challenge);
});
