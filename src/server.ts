import Fastify, { type FastifyError } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { config } from './config.ts';
import { ChannelError } from './channels/types.ts';
import { registerApiRoutes } from './routes/api.ts';
import { registerOauthRoutes } from './routes/oauth.ts';
import { registerFeedRoutes } from './routes/feeds.ts';
import { registerPageRoutes } from './routes/pages.ts';

const app = Fastify({
  logger: { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } },
  bodyLimit: 2 * 1024 * 1024,
});

await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 20 } });

// Interface do painel.
await app.register(fastifyStatic, {
  root: resolve(config.root, 'public'),
  prefix: '/',
});

// Fotos dos produtos: e esta URL que as plataformas usam para baixar as imagens.
await app.register(fastifyStatic, {
  root: config.uploadsDir,
  prefix: '/uploads/',
  decorateReply: false,
  index: false,
  list: false,
});

app.setErrorHandler((err: FastifyError, _req, reply) => {
  const cause: unknown = err;
  if (cause instanceof ChannelError) {
    return reply.status(400).send({ error: cause.message, detail: cause.detail });
  }
  if (err.validation) {
    return reply.status(400).send({ error: err.message });
  }
  app.log.error(err);
  return reply.status(err.statusCode ?? 500).send({ error: err.message || 'erro interno' });
});

await app.register(registerApiRoutes, { prefix: '/api' });
await app.register(registerOauthRoutes, { prefix: '/oauth' });
await app.register(registerFeedRoutes, { prefix: '/feeds' });
await app.register(registerPageRoutes);

await app.listen({ port: config.port, host: config.host });

app.log.info(
  config.dryRun
    ? 'DRY_RUN ligado: as publicacoes montam o payload mas nao chamam as plataformas.'
    : 'DRY_RUN desligado: as publicacoes serao enviadas de verdade.',
);
