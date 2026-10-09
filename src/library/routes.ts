import type { Context, Hono } from 'hono';
import { CloudError, metadataSchema, publishSchema, type CloudUser } from './contracts.ts';
import { LibraryRepository, summary } from './repository.ts';
import { validatePublication } from './publication.ts';
import { z } from 'zod';

type Env = { Bindings: { DB: D1Database } };
interface Auth {
  viewer(c:Context<Env>):Promise<CloudUser|null>;
  writer(c:Context<Env>):Promise<CloudUser>;
  member(c:Context<Env>):Promise<CloudUser>;
  readJson(request:Request):Promise<unknown>;
}
export function registerLibraryRoutes(app:Hono<Env>,auth:Auth) {
  app.get('/v2/library/capabilities', (c) => c.json({ protocolVersion:'f8cloud-api/2',publicationVersions:['f8publication/1'],graphVersions:[4],componentVersions:[1],hashProfiles:['f8publication-hash/1'] }));
  app.get('/v2/library', async (c) => {
    const viewer = await auth.viewer(c);
    const view = z.enum(['all','mine','following']).parse(c.req.query('view') ?? 'all');
    if (view !== 'all' && viewer === null) throw new CloudError(401,'authentication_required','Sign in to view your Library');
    return c.json(await new LibraryRepository(c.env.DB).search(viewer?.userId ?? null,(c.req.query('q') ?? '').slice(0,500),c.req.query('cursor') ?? '',view));
  });
  app.post('/v2/library/publish', async (c) => {
    const user = await auth.writer(c);
    const input = publishSchema.parse(await auth.readJson(c.req.raw));
    const publication = await validatePublication(input.publication);
    return c.json(await new LibraryRepository(c.env.DB,new URL(c.req.url).origin).publish({...input,publication},user));
  });
  app.get('/v2/library/:assetId', async (c) => {
    const user = await auth.viewer(c); const repo = new LibraryRepository(c.env.DB); const id = c.req.param('assetId');
    return c.json({...summary(await repo.asset(id,user?.userId ?? null)),relations:await repo.relations(id,user?.userId ?? null)});
  });
  app.put('/v2/library/:assetId/metadata', async (c) => {
    const user = await auth.writer(c);
    return c.json(await new LibraryRepository(c.env.DB).metadata(c.req.param('assetId'),user.userId,metadataSchema.parse(await auth.readJson(c.req.raw))));
  });
  app.get('/v2/library/:assetId/versions', async (c) => {
    const user = await auth.viewer(c);
    return c.json(await new LibraryRepository(c.env.DB).versions(c.req.param('assetId'),user?.userId ?? null));
  });
  app.get('/v2/library/:assetId/versions/:version', async (c) => {
    const user = await auth.viewer(c); const version = z.coerce.number().int().positive().parse(c.req.param('version'));
    const row = await new LibraryRepository(c.env.DB).version(c.req.param('assetId'),version,user?.userId ?? null);
    c.header('ETag',`"${row.content_hash}"`); c.header('Cache-Control','private, max-age=0, must-revalidate');
    return c.json(JSON.parse(row.publication_json));
  });
  app.on(['PUT','DELETE'],'/v2/library/:assetId/relations/:action',async (c) => {
    const user = await auth.member(c); const action = z.enum(['like','follow','follow-author']).parse(c.req.param('action'));
    return c.json(await new LibraryRepository(c.env.DB).relate(c.req.param('assetId'),user.userId,action,c.req.method==='PUT'));
  });
}
