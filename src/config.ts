import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function packageVersion() {
  try {
    return (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * URL que so o proprio computador alcanca. As plataformas baixam as fotos pela
 * PUBLIC_URL, entao url local significa que nenhuma foto chega -- e significa
 * tambem que o app nao esta exposto na internet.
 */
export function isLocalUrl(url: string) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(url);
}

function bool(v: string | undefined, fallback: boolean) {
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

export const config = {
  root,
  version: packageVersion(),
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '127.0.0.1',
  publicUrl: (process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`).replace(/\/$/, ''),
  dataDir: process.env.DATA_DIR ?? resolve(root, 'data'),
  uploadsDir: process.env.UPLOADS_DIR ?? resolve(root, 'data/uploads'),
  dbFile: process.env.DB_FILE ?? resolve(root, 'data/anuncios.db'),
  /** Com DRY_RUN ligado nenhuma chamada real de publicacao e feita: o payload e gravado e devolvido. */
  dryRun: bool(process.env.DRY_RUN, true),
  olxFeedToken: process.env.OLX_FEED_TOKEN ?? '',
  seller: {
    name: process.env.SELLER_NAME ?? '',
    phone: process.env.SELLER_PHONE ?? '',
    cep: process.env.SELLER_CEP ?? '',
    city: process.env.SELLER_CITY ?? '',
    uf: process.env.SELLER_UF ?? '',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    imageModel: process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image',
  },
  /** Basic auth do painel. Sem senha o hook nao e registrado (uso local). */
  admin: {
    user: process.env.ADMIN_USER ?? 'admin',
    pass: process.env.ADMIN_PASS ?? '',
    /** Escape consciente para rodar sem senha mesmo com PUBLIC_URL publica. */
    allowNoAuth: bool(process.env.ALLOW_NO_AUTH, false),
  },
  image: {
    /** Lado maior do derivado servido as plataformas. */
    maxSide: Number(process.env.IMAGE_MAX_SIDE ?? 1600),
    quality: Number(process.env.IMAGE_QUALITY ?? 85),
  },
  channels: {
    mercadolivre: {
      clientId: process.env.ML_CLIENT_ID ?? '',
      clientSecret: process.env.ML_CLIENT_SECRET ?? '',
      redirectUri: process.env.ML_REDIRECT_URI ?? '',
      siteId: process.env.ML_SITE_ID ?? 'MLB',
    },
    facebook: {
      appId: process.env.FB_APP_ID ?? '',
      appSecret: process.env.FB_APP_SECRET ?? '',
      catalogId: process.env.FB_CATALOG_ID ?? '',
      accessToken: process.env.FB_ACCESS_TOKEN ?? '',
      apiVersion: process.env.FB_API_VERSION ?? 'v21.0',
    },
    olx: {
      clientId: process.env.OLX_CLIENT_ID ?? '',
      clientSecret: process.env.OLX_CLIENT_SECRET ?? '',
      accessToken: process.env.OLX_ACCESS_TOKEN ?? '',
    },
  },
} as const;

export type Config = typeof config;
