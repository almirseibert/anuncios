import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A regra "exposto sem senha nao sobe" so vale se valer no processo inteiro:
 * testamos registerBasicAuth num processo separado, com o ambiente de verdade.
 */
function comAmbiente(env: Record<string, string>) {
  const sandbox = mkdtempSync(join(tmpdir(), 'anuncios-guard-'));
  const script = `
    const { default: Fastify } = await import('fastify');
    const { registerBasicAuth } = await import('${process.cwd()}/src/lib/auth.ts');
    const app = Fastify({ logger: false });
    registerBasicAuth(app);
    console.log('SUBIU');
  `;
  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: {
        ...process.env,
        DATA_DIR: sandbox,
        UPLOADS_DIR: join(sandbox, 'uploads'),
        DB_FILE: join(sandbox, 'test.db'),
        ADMIN_PASS: '',
        ALLOW_NO_AUTH: '',
        ...env,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stderr?: string };
    return { ok: false, out: e.stderr ?? '' };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test('sem senha e com PUBLIC_URL publica, o servidor recusa subir', () => {
  const r = comAmbiente({ PUBLIC_URL: 'https://anuncios.easypanel.host' });
  assert.equal(r.ok, false);
  assert.match(r.out, /ADMIN_PASS/);
  assert.match(r.out, /ALLOW_NO_AUTH/);
});

test('sem senha em localhost continua subindo (uso local nao muda)', () => {
  const r = comAmbiente({ PUBLIC_URL: 'http://127.0.0.1:3000' });
  assert.equal(r.ok, true, r.out);
  assert.match(r.out, /SUBIU/);
});

test('ALLOW_NO_AUTH permite o modo aberto de proposito', () => {
  const r = comAmbiente({ PUBLIC_URL: 'https://anuncios.easypanel.host', ALLOW_NO_AUTH: 'true' });
  assert.equal(r.ok, true, r.out);
});

test('com senha, sobe em qualquer URL', () => {
  const r = comAmbiente({ PUBLIC_URL: 'https://anuncios.easypanel.host', ADMIN_PASS: 'segredo' });
  assert.equal(r.ok, true, r.out);
});
