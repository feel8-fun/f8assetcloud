import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Hono } from 'hono';
import { createSqliteD1Database } from '../test_support/sqlite_d1_adapter.js';
import { validatePublication, hashValue, publicationHash } from '../src/library/publication.ts';
import { LibraryRepository } from '../src/library/repository.ts';
import { CloudError } from '../src/library/contracts.ts';
import { registerLibraryRoutes } from '../src/library/routes.ts';
import { AssetRepository } from '../src/repository.js';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const migrations = fs.readdirSync(new URL('../migrations',import.meta.url)).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => fs.readFileSync(new URL(`../migrations/${f}`,import.meta.url),'utf8')).join('\n');
function setup() {
  const db = createSqliteD1Database({migrationsSql:migrations});
  for (const id of ['author','reader']) db.prepare(`INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES(?,?,?,?,?)`).bind(id,id,`${id}@example.com`,0,0).run();
  return {db,repo:new LibraryRepository(db)};
}
async function input(overrides = {}) { return {requestId:crypto.randomUUID(),assetId:null,expectedVersion:0,kind:'component',name:'Smooth',description:'Script template',tags:['script'],visibility:'public',changeSummary:'Initial',publication:await validatePublication(fixture('component-v1')),...overrides}; }
const author = {userId:'author',name:'Author'};
test('generated publication fixtures and cross-language hash vectors agree',async () => {
  for (const f of fixture('hash-v1')) assert.equal(await hashValue(f.value),f.sha256);
  for (const name of ['graph-v1','component-v1']) assert.equal((await validatePublication(fixture(name))).contentHash,fixture(name).contentHash);
  const value = fixture('component-v1'); const first = Object.values(value.content.operators)[0]; delete first.enabled;
  assert.equal((await validatePublication(value)).contentHash,fixture('component-v1').contentHash);
});
test('publication rejects hash tampering, legacy format and private instance values but permits definition defaults',async () => {
  const raw = fixture('component-v1'); raw.contentHash = 'bad'; await assert.rejects(validatePublication(raw),/hash mismatch/);
  await assert.rejects(validatePublication({schemaVersion:'f8studio-session/1',layout:{}}),/explicit conversion/);
  const privateValue = fixture('component-v1'); Object.values(privateValue.content.operators)[0].stateValues.path='/private/file';
  await assert.rejects(validatePublication(privateValue),/Nonpublishable/);
  const wrongType=fixture('component-v1');Object.values(wrongType.content.operators)[0].stateValues.gain='invalid';
  wrongType.contentHash=await publicationHash(wrongType);await assert.rejects(validatePublication(wrongType),/Invalid configuration/);
  assert.ok(JSON.stringify(await validatePublication(fixture('component-v1'))).includes('example.txt'));
});
test('atomic publish deduplicates identical content and durable request IDs, rejects reuse and concurrent updates',async () => {
  const {db,repo} = setup(); const initial = await input();
  const result = await repo.publish(initial,author); assert.equal(result.version,1);
  assert.deepEqual(await new LibraryRepository(db).publish(initial,author),result);
  await assert.rejects(repo.publish({...initial,name:'Different'},author),/already used/);
  assert.equal((await repo.publish(await input({assetId:result.assetId,expectedVersion:1}),author)).changed,false);
  const changed = fixture('component-v1'); Object.values(changed.content.operators)[0].stateValues.gain=3; changed.contentHash = await publicationHash(changed);
  const update = await input({assetId:result.assetId,expectedVersion:1,publication:await validatePublication(changed)});
  const results = await Promise.allSettled([repo.publish(update,author),repo.publish({...update,requestId:'second'},author)]);
  assert.equal(results.filter((r) => r.status==='fulfilled').length,1);
  assert.equal(results.filter((r) => r.status==='rejected').length,1);
  assert.equal((await repo.versions(result.assetId,null)).length,2);
  assert.equal(JSON.parse((await repo.version(result.assetId,1,null)).publication_json).contentHash,initial.publication.contentHash);
  await assert.rejects(db.prepare('UPDATE cloud_versions SET content_hash=? WHERE asset_id=?').bind('bad',result.assetId).run(),/immutable/);
});
test('privacy, ownership, metadata and independent idempotent community relations',async () => {
  const {repo} = setup(); const result = await repo.publish(await input(),author);
  await assert.rejects(repo.publish(await input({assetId:result.assetId,expectedVersion:1}),{userId:'reader'}),/owner/);
  for (const action of ['like','follow','follow-author']) { await repo.relate(result.assetId,'reader',action,true); await repo.relate(result.assetId,'reader',action,true); }
  assert.deepEqual(await repo.relations(result.assetId,'reader'),{likes:1,liked:true,following:true,followingAuthor:true,hasUpdate:false,latestVersion:1});
  assert.equal((await repo.search('reader','','','following')).items.length,1);
  await repo.relate(result.assetId,'reader','like',false);
  assert.equal((await repo.relations(result.assetId,'reader')).following,true);
  await repo.metadata(result.assetId,'author',{name:'New name',description:'changed',tags:[],visibility:'private'});
  await assert.rejects(repo.asset(result.assetId,'reader'),/not found/);
  assert.equal((await repo.search(null,'','','all')).items.length,0);
  assert.equal((await repo.versions(result.assetId,'author')).length,1);
});
test('Library HTTP pagination, anonymous search and fixed versions',async () => {
  const {db,repo} = setup();
  for(let i=0;i<32;i++) await repo.publish(await input({name:`Template 中文 ${String(i).padStart(2,'0')}`}),author);
  const app = new Hono(); registerLibraryRoutes(app,{viewer:async()=>null,writer:async()=>author,member:async()=>author,readJson:(r)=>r.json()});
  app.onError((e,c)=>c.json({message:e.message},e instanceof CloudError?e.status:500));
  const env={DB:db}; const first = await (await app.request('http://test/v2/library?q=Template',{},env)).json();
  assert.equal(first.items.length,30); assert.ok(first.nextCursor);
  const second = await (await app.request(`http://test/v2/library?q=Template&cursor=${encodeURIComponent(first.nextCursor)}`,{},env)).json();
  assert.equal(second.items.length,2);
  assert.equal((await app.request('http://test/v2/library?view=following',{},env)).status,401);
  const asset=first.items[0]; const version=await app.request(`http://test/v2/library/${asset.assetId}/versions/1`,{},env);
  assert.equal(version.status,200); assert.equal((await version.json()).contentHash,asset.contentHash);
});

test('same-name graphs, components and variants keep independent identities and actions',async()=>{
  const {repo}=setup(); const publications={};
  for(const kind of ['graph','component','variant']) {
    publications[kind]=await repo.publish(await input({kind,name:'Shared name',
      publication:await validatePublication(fixture(kind==='graph'?'graph-v1':'component-v1'))}),author);
  }
  assert.equal(new Set(Object.values(publications).map((item)=>item.assetId)).size,3);
  assert.equal((await repo.search(null,'Shared name','','all')).items.length,3);
  for(const kind of ['graph','component','variant']) {
    const page=await repo.search('author','Shared name','','mine',kind);
    assert.deepEqual(page.items.map((item)=>item.assetId),[publications[kind].assetId]);
    assert.equal(page.items[0].kind,kind);
  }
  await repo.relate(publications.component.assetId,'reader','like',true);
  assert.equal((await repo.relations(publications.graph.assetId,'reader')).likes,0);
  assert.equal((await repo.relations(publications.variant.assetId,'reader')).likes,0);
  await repo.deletePublication(publications.graph.assetId,'author');
  assert.equal((await repo.asset(publications.component.assetId,'author')).name,'Shared name');
  assert.equal((await repo.asset(publications.variant.assetId,'author')).name,'Shared name');
});

test('kind filters apply before HTTP pagination and preserve ownership and following scope',async()=>{
  const {db,repo}=setup(); const graph=await validatePublication(fixture('graph-v1'));
  for(let i=0;i<32;i++) {
    await repo.publish(await input({name:'Shared name',kind:'graph',publication:graph}),author);
    await repo.publish(await input({name:'Shared name'}),author);
  }
  await repo.publish(await input({name:'Shared name',kind:'variant'}),author);
  const privateGraph=await repo.publish(await input({name:'Shared name',kind:'graph',publication:graph,visibility:'private'}),author);
  const readerComponent=await repo.publish(await input({name:'Shared name'}),{userId:'reader',name:'Reader'});
  await repo.relate(readerComponent.assetId,'author','follow',true);
  let viewer=null;
  const app=new Hono();registerLibraryRoutes(app,{viewer:async()=>viewer,writer:async()=>author,member:async()=>author,readJson:(r)=>r.json()});
  app.onError((e,c)=>c.json({code:e.code,message:e.message},e instanceof CloudError?e.status:500));
  const env={DB:db};
  for(const kind of ['graph','component']) {
    const firstResponse=await app.request(`http://test/v2/library?q=Shared&kind=${kind}`,{},env);
    assert.equal(firstResponse.status,200);const first=await firstResponse.json();
    assert.equal(first.items.length,30);assert.ok(first.nextCursor);
    const secondResponse=await app.request(`http://test/v2/library?q=Shared&kind=${kind}&cursor=${encodeURIComponent(first.nextCursor)}`,{},env);
    assert.equal(secondResponse.status,200);const second=await secondResponse.json();
    const items=[...first.items,...second.items];
    assert.equal(items.length,kind==='graph'?32:33);
    assert.ok(items.every((item)=>item.kind===kind));
    assert.equal(new Set(items.map((item)=>item.assetId)).size,items.length);
    assert.ok(items.every((item)=>item.assetId!==privateGraph.assetId));
    const otherKind=kind==='graph'?'component':'graph';
    assert.equal((await app.request(`http://test/v2/library?q=Shared&kind=${otherKind}&cursor=${encodeURIComponent(first.nextCursor)}`,{},env)).status,400);
  }
  assert.equal((await app.request('http://test/v2/library?kind=unknown',{},env)).status,400);
  viewer=author;
  const mine=await (await app.request('http://test/v2/library?kind=component&view=mine',{},env)).json();
  assert.ok(mine.items.every((item)=>item.kind==='component'&&item.author.id==='author'));
  assert.ok(mine.items.every((item)=>item.assetId!==readerComponent.assetId));
  const following=await (await app.request('http://test/v2/library?kind=component&view=following',{},env)).json();
  assert.deepEqual(following.items.map((item)=>item.assetId),[readerComponent.assetId]);
  assert.equal((await (await app.request('http://test/v2/library?kind=graph&view=following',{},env)).json()).items.length,0);
  // Before kind filters existed, a cursor had four entries. It still works
  // for an unfiltered request, but cannot be reused for a filtered request.
  const first=await repo.search(null,'Shared','','all');
  const legacy=Buffer.from(JSON.stringify(JSON.parse(Buffer.from(first.nextCursor,'base64url').toString('utf8')).slice(0,4)),'utf8').toString('base64url');
  assert.ok((await repo.search(null,'Shared',legacy,'all')).items.length);
  await assert.rejects(repo.search(null,'Shared',legacy,'all','graph'),/this search/);
});

test('database failure rolls back heads, versions and receipt together and the same request can retry',async()=>{
  const {db,repo}=setup();const command=await input();
  await db.prepare("CREATE TRIGGER fail_publish BEFORE INSERT ON cloud_versions BEGIN SELECT RAISE(ABORT,'test_failure'); END").run();
  await assert.rejects(repo.publish(command,author),/test_failure/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM cloud_assets').first()).n,0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM cloud_publish_requests').first()).n,0);
  await db.prepare('DROP TRIGGER fail_publish').run();
  assert.equal((await repo.publish(command,author)).version,1);
});
test('derivatives require a readable fixed source and supported license, and preserve their source',async()=>{
  const {repo}=setup();const publication=fixture('component-v1');publication.manifest.license='UNLICENSED';publication.contentHash=await publicationHash(publication);
  const original=await repo.publish(await input({publication:await validatePublication(publication)}),author);
  const derivative=fixture('component-v1');derivative.manifest.source={repositoryUrl:null,assetId:original.assetId,assetVersion:1};derivative.contentHash=await publicationHash(derivative);
  await assert.rejects(repo.publish(await input({publication:await validatePublication(derivative)}),{userId:'reader',name:'Reader'}),/license/);
  const allowed=await repo.publish(await input(),author);
  derivative.manifest.source.assetId=allowed.assetId;derivative.contentHash=await publicationHash(derivative);
  const fork=await repo.publish(await input({publication:await validatePublication(derivative)}),{userId:'reader',name:'Reader'});
  const stored=JSON.parse((await repo.version(fork.assetId,1,'reader')).publication_json);
  assert.equal(stored.manifest.source.assetId,allowed.assetId);assert.notEqual(fork.assetId,allowed.assetId);
});
test('new-version follow hints do not download or mutate earlier content',async()=>{
  const {repo}=setup();const original=await repo.publish(await input(),author);
  await repo.relate(original.assetId,'reader','follow',true);
  const publication=fixture('component-v1');publication.manifest.license='Apache-2.0';publication.contentHash=await publicationHash(publication);
  await repo.publish(await input({assetId:original.assetId,expectedVersion:1,publication:await validatePublication(publication)}),author);
  const relations=await repo.relations(original.assetId,'reader');assert.equal(relations.hasUpdate,true);assert.equal(relations.latestVersion,2);
  assert.equal((await repo.version(original.assetId,1,'reader')).content_hash,original.contentHash);
  const versions=await repo.versions(original.assetId,'reader');
  assert.equal(versions[0].license,'Apache-2.0');assert.equal(versions[1].license,'MIT');
});
test('legacy account deletion guard and explicit admin purge include v2 assets',async()=>{
  const {db,repo}=setup();const legacy=new AssetRepository(db);
  await repo.publish(await input(),author);
  assert.equal(await legacy.hasAssets('author'),true);
  const purge=await legacy.adminPurgeAllAssets();assert.equal(purge.deletedAssets,1);assert.equal(purge.deletedAssetVersions,1);
  assert.equal(await legacy.hasAssets('author'),false);
});

test('owner deletion cascades asset data, preserves other works and rejects stale publish receipts',async()=>{
  const {db,repo}=setup(); const command=await input();
  const original=await repo.publish(command,author);
  const other=await repo.publish(await input({name:'Keep this work'}),author);
  const publication=fixture('component-v1');publication.manifest.license='Apache-2.0';publication.contentHash=await publicationHash(publication);
  await repo.publish(await input({assetId:original.assetId,expectedVersion:1,publication:await validatePublication(publication)}),author);
  for(const action of ['like','follow','follow-author'])await repo.relate(original.assetId,'reader',action,true);
  await assert.rejects(repo.deletePublication(original.assetId,'reader'),(error)=>error instanceof CloudError&&error.status===403);
  await repo.metadata(original.assetId,'author',{name:'Private work',description:'',tags:[],visibility:'private'});
  await assert.rejects(repo.deletePublication(original.assetId,'reader'),(error)=>error instanceof CloudError&&error.status===404);
  assert.deepEqual(await repo.deletePublication(original.assetId,'author'),{assetId:original.assetId});
  assert.deepEqual(await repo.deletePublication(original.assetId,'author'),{assetId:original.assetId});
  await assert.rejects(repo.deletePublication(original.assetId,'reader'),(error)=>error instanceof CloudError&&error.status===404);
  const receipt=await db.prepare('SELECT publication_json,name,description FROM cloud_publish_requests WHERE asset_id=?').bind(original.assetId).first();
  assert.deepEqual({...receipt},{publication_json:'{}',name:'',description:''});
  for(const table of ['cloud_assets','cloud_versions','cloud_asset_likes','cloud_asset_follows'])
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE asset_id=?`).bind(original.assetId).first()).n,0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM cloud_author_follows WHERE author_id=?').bind('author').first()).n,1);
  assert.equal((await repo.asset(other.assetId,'author')).name,'Keep this work');
  assert.equal((await repo.search('author','','','mine')).items.length,1);
  await assert.rejects(repo.publish(command,author),(error)=>error instanceof CloudError&&error.status===410);
  const republished=await repo.publish(await input(),author);
  assert.notEqual(republished.assetId,original.assetId);
  assert.equal(republished.version,1);
});

test('HTTP deletion authenticates the author and removes fixed version endpoints',async()=>{
  const {db,repo}=setup();const result=await repo.publish(await input(),author);
  let user=null;
  const app=new Hono();registerLibraryRoutes(app,{
    viewer:async()=>user,member:async()=>user,
    writer:async()=>{if(!user)throw new CloudError(401,'authentication_required','Sign in');return user;},readJson:(r)=>r.json(),
  });
  app.onError((e,c)=>c.json({code:e.code,message:e.message},e instanceof CloudError?e.status:500));
  const path=`http://test/v2/library/${result.assetId}`;const env={DB:db};
  assert.equal((await app.request(path,{method:'DELETE'},env)).status,401);
  user={userId:'reader',name:'Reader'};
  assert.equal((await app.request(path,{method:'DELETE'},env)).status,403);
  user=author;
  const removed=await app.request(path,{method:'DELETE'},env);
  assert.equal(removed.status,200);assert.deepEqual(await removed.json(),{assetId:result.assetId});
  assert.equal((await app.request(path+'/versions/1',{},env)).status,404);
});
