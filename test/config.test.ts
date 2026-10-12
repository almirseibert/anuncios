import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLUMN_MIGRATIONS } from '../src/db/schema.ts';

test('COLUMN_MIGRATIONS nao repete tabela+coluna', () => {
  const seen = new Set<string>();
  for (const m of COLUMN_MIGRATIONS) {
    const key = `${m.table}.${m.column}`;
    assert.equal(seen.has(key), false, `migracao duplicada: ${key}`);
    seen.add(key);
  }
});

test('cada migracao adiciona a propria coluna que declara', () => {
  for (const m of COLUMN_MIGRATIONS) {
    assert.match(m.ddl, new RegExp(`^ALTER TABLE ${m.table} ADD COLUMN ${m.column}\\b`));
  }
});
