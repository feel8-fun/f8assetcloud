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
});
test('legacy account deletion guard and explicit admin purge include v2 assets',async()=>{
  const {db,repo}=setup();const legacy=new AssetRepository(db);
  await repo.publish(await input(),author);
  assert.equal(await legacy.hasAssets('author'),true);
  const purge=await legacy.adminPurgeAllAssets();assert.equal(purge.deletedAssets,1);assert.equal(purge.deletedAssetVersions,1);
  assert.equal(await legacy.hasAssets('author'),false);
});
