/**
 * The HTTP API. Read-only: the server owns the world and the browser views it.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { ApiError, ImportReport, SettlementBrief, World } from '@worldsim/core';
import { mapGeometry, settlementList, worldSummary } from './views.ts';

export function buildApp(world: World, report: ImportReport): FastifyInstance {
  const app = Fastify();

  // The world does not change while the server runs, so each body is built once.
  const summary = JSON.stringify(worldSummary(world, report));
  const geometry = JSON.stringify(mapGeometry(world));
  const settlements = JSON.stringify(settlementList(world));
  const briefs = new Map<string, SettlementBrief>(world.settlements.map((brief) => [brief.id, brief]));

  // The viewer is served from another origin, often another machine.
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
  });

  const json = 'application/json; charset=utf-8';
  app.get('/api/world', (_request, reply) => reply.type(json).send(summary));
  app.get('/api/map', (_request, reply) => reply.type(json).send(geometry));
  app.get('/api/settlements', (_request, reply) => reply.type(json).send(settlements));
  app.get<{ Params: { id: string } }>('/api/settlements/:id', (request, reply) => {
    const brief = briefs.get(request.params.id);
    if (!brief) {
      const body: ApiError = { error: `no settlement has the ID "${request.params.id}"` };
      return reply.code(404).send(body);
    }
    return reply.send(brief);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ApiError = { error: `nothing is served at ${request.method} ${request.url}` };
    reply.code(404).send(body);
  });

  return app;
}
