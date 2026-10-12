export const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('geral','veiculo','imovel')),
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  price_cents   INTEGER NOT NULL DEFAULT 0,
  condition     TEXT NOT NULL DEFAULT 'usado' CHECK (condition IN ('novo','usado')),
  quantity      INTEGER NOT NULL DEFAULT 1,
  accepts_trade INTEGER NOT NULL DEFAULT 0,
  cep           TEXT NOT NULL DEFAULT '',
  city          TEXT NOT NULL DEFAULT '',
  uf            TEXT NOT NULL DEFAULT '',
  neighborhood  TEXT NOT NULL DEFAULT '',
  attrs_json    TEXT NOT NULL DEFAULT '{}',
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS images (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_product ON images(product_id, position);

CREATE TABLE IF NOT EXISTS channel_accounts (
  channel        TEXT PRIMARY KEY,
  label          TEXT NOT NULL DEFAULT '',
  access_token   TEXT,
  refresh_token  TEXT,
  expires_at     TEXT,
  meta_json      TEXT NOT NULL DEFAULT '{}',
  connected_at   TEXT
);

CREATE TABLE IF NOT EXISTS listings (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'rascunho'
               CHECK (status IN ('rascunho','publicando','publicado','pausado','encerrado','erro')),
  external_id  TEXT,
  permalink    TEXT,
  payload_json TEXT,
  result_json  TEXT,
  error        TEXT,
  published_at TEXT,
  updated_at   TEXT NOT NULL,
  UNIQUE (product_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_listings_product ON listings(product_id);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT,
  channel    TEXT,
  level      TEXT NOT NULL DEFAULT 'info',
  message    TEXT NOT NULL,
  data_json  TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
`;
