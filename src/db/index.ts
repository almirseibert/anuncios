import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.ts';
import { SCHEMA } from './schema.ts';

mkdirSync(dirname(config.dbFile), { recursive: true });
mkdirSync(config.uploadsDir, { recursive: true });

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(SCHEMA);

type Row = Record<string, unknown>;

/** Converte a row null-prototype do node:sqlite em objeto comum. */
function plain<T>(row: Row | undefined): T | undefined {
  return row ? ({ ...row } as T) : undefined;
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])).map((r) => ({ ...(r as Row) })) as T[];
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return plain<T>(db.prepare(sql).get(...(params as never[])) as Row | undefined);
}

export function run(sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...(params as never[]));
}

/** Executa fn dentro de uma transacao; faz rollback em caso de erro. */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function nowIso() {
  return new Date().toISOString();
}
