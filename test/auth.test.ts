import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'anuncios-auth-'));
process.env.DATA_DIR = sandbox;
process.env.UPLOADS_DIR = join(sandbox, 'uploads');
process.env.DB_FILE = join(sandbox, 'test.db');

const { isLocalUrl } = await import('../src/config.ts');

after(() => rmSync(sandbox, { recursive: true, force: true }));

test('isLocalUrl reconhece o que so o proprio computador alcanca', () => {
  for (const url of [
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    'https://localhost',
    'http://0.0.0.0:3000',
  ]) {
    assert.equal(isLocalUrl(url), true, url);
  }
});

test('isLocalUrl nao confunde dominio publico com local', () => {
  for (const url of [
    'https://anuncios-app.easypanel.host',
    'https://localhost.exemplo.com.br',
    'https://meu-localhost.com',
    'https://127.0.0.1.exemplo.com',
  ]) {
    assert.equal(isLocalUrl(url), false, url);
  }
});
