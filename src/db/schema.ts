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
  -- atributos exigidos por cada plataforma (ex.: VOLTAGE no ML), fora de attrs
  -- de proposito: o formulario do produto regrava attrs e apagaria estes.
  channel_attrs_json TEXT NOT NULL DEFAULT '{}',
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
  width      INTEGER NOT NULL DEFAULT 0,
  height     INTEGER NOT NULL DEFAULT 0,
  -- de onde a foto veio. Só 'upload' (foto sua) pode ser capa do anúncio.
  origin     TEXT NOT NULL DEFAULT 'upload'
             CHECK (origin IN ('upload','catalogo','url','ia')),
  source_url    TEXT NOT NULL DEFAULT '',
  source_label  TEXT NOT NULL DEFAULT '',
  -- arquivo original intacto em uploads/originals, para refazer ou desfazer tratamento.
  original_filename TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_product ON images(product_id, position);

-- Link temporario para enviar fotos pelo celular (QR Code do painel).
-- E o unico jeito de o celular postar foto sem passar pelo basic auth.
CREATE TABLE IF NOT EXISTS upload_tokens (
  token      TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upload_tokens_product ON upload_tokens(product_id);

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

-- Anuncios de produtos excluidos aqui: a importacao do ML nao os traz de volta
-- (ela importa encerrados tambem, e excluir encerra o anuncio).
CREATE TABLE IF NOT EXISTS removed_listings (
  channel     TEXT NOT NULL,
  external_id TEXT NOT NULL,
  removed_at  TEXT NOT NULL,
  PRIMARY KEY (channel, external_id)
);
`;

/**
 * Colunas adicionadas depois do banco ja existir. `CREATE TABLE IF NOT EXISTS`
 * nao altera tabela criada: cada entrada aqui e aplicada com ALTER TABLE se faltar.
 * A lista e append-only — nunca edite uma entrada ja publicada.
 */
export const COLUMN_MIGRATIONS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: 'images', column: 'width', ddl: 'ALTER TABLE images ADD COLUMN width INTEGER NOT NULL DEFAULT 0' },
  { table: 'images', column: 'height', ddl: 'ALTER TABLE images ADD COLUMN height INTEGER NOT NULL DEFAULT 0' },
  // Sem CHECK: o SQLite nao aceita CHECK em ADD COLUMN; quem valida e o zod/servico.
  { table: 'images', column: 'origin', ddl: "ALTER TABLE images ADD COLUMN origin TEXT NOT NULL DEFAULT 'upload'" },
  { table: 'images', column: 'source_url', ddl: "ALTER TABLE images ADD COLUMN source_url TEXT NOT NULL DEFAULT ''" },
  { table: 'images', column: 'source_label', ddl: "ALTER TABLE images ADD COLUMN source_label TEXT NOT NULL DEFAULT ''" },
  {
    table: 'images',
    column: 'original_filename',
    ddl: "ALTER TABLE images ADD COLUMN original_filename TEXT NOT NULL DEFAULT ''",
  },
  {
    table: 'products',
    column: 'channel_attrs_json',
    ddl: "ALTER TABLE products ADD COLUMN channel_attrs_json TEXT NOT NULL DEFAULT '{}'",
  },
];
