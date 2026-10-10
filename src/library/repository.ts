import { CloudError, type AssetRow, type CloudUser, type LibraryKindFilter, type PublishInput, type VersionRow } from './contracts.ts';
import { hashValue } from './publication.ts';
import { Buffer } from 'node:buffer';

export class LibraryRepository {
  readonly db: D1Database;
  readonly registry: string | null;
  constructor(db: D1Database, registry: string | null = null) { this.db=db; this.registry=registry; }
  async publish(input: PublishInput, user: CloudUser) {
    if (new TextEncoder().encode(JSON.stringify(input.publication)).byteLength > 1024 * 1024)
      throw new CloudError(413,'publication_too_large','Publication exceeds the 1 MiB D1 content limit; resource attachments are not supported');
    const fingerprint = await hashValue(input);
    const receipt = await this.db.prepare(`SELECT fingerprint,asset_id,result_version,result_changed,content_hash
      FROM cloud_publish_requests WHERE user_id=? AND request_id=?`).bind(user.userId,input.requestId)
      .first<{fingerprint:string;asset_id:string;result_version:number;result_changed:number;content_hash:string}>();
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new CloudError(409,'idempotency_conflict','Request ID was already used for a different publication');
      if (!await this.db.prepare('SELECT asset_id FROM cloud_assets WHERE asset_id=? AND owner_user_id=?')
        .bind(receipt.asset_id,user.userId).first())
        throw new CloudError(410,'publication_deleted','This publication was deleted; publish again with a new request ID');
      return {assetId:receipt.asset_id,version:receipt.result_version,contentHash:receipt.content_hash,changed:receipt.result_changed===1};
    }
    if ((input.assetId === null) !== (input.expectedVersion === 0)) throw new CloudError(400, 'invalid_version', 'New assets use null assetId and expectedVersion 0');
    if ((input.kind === 'graph') !== (input.publication.kind === 'graph')) throw new CloudError(422, 'kind_mismatch', 'Asset kind does not match publication');
    if (input.kind === 'variant' && Object.keys(input.publication.content.services).length + Object.keys(input.publication.content.operators).length !== 1)
      throw new CloudError(422, 'invalid_variant', 'A Variant must contain exactly one template node');
    const source = input.publication.manifest.source;
    if (source.assetId !== null && source.assetId !== undefined) {
      if (source.repositoryUrl && this.registry && source.repositoryUrl !== this.registry)
        throw new CloudError(422,'unsupported_source_registry','Derivative source must belong to this registry');
      const original = await this.asset(source.assetId, user.userId);
      const originalVersion = await this.version(source.assetId, source.assetVersion!, user.userId);
      const sourceLicense = (JSON.parse(originalVersion.publication_json) as PublishInput['publication']).manifest.license;
      const permissive = ['MIT','Apache-2.0','BSD-2-Clause','BSD-3-Clause','ISC','CC0-1.0','CC-BY-4.0'];
      const sameLicense = ['MPL-2.0','GPL-3.0-only','GPL-3.0-or-later','GPL-2.0-only','GPL-2.0-or-later','LGPL-3.0-only','LGPL-3.0-or-later','CC-BY-SA-4.0'];
      if (original.owner_user_id !== user.userId && !permissive.includes(sourceLicense) &&
          !(sameLicense.includes(sourceLicense) && input.publication.manifest.license === sourceLicense))
        throw new CloudError(403,'license_restriction','Source license does not permit this derivative license; choose a supported reuse license or obtain author permission');
    }
    const assetId = input.assetId ?? crypto.randomUUID();
    try {
      await this.db.prepare(`INSERT INTO cloud_publish_requests
        (user_id,request_id,fingerprint,asset_id,expected_version,kind,name,description,tags_json,visibility,
         content_hash,license,publication_json,change_summary,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,request_id) DO NOTHING`)
        .bind(user.userId,input.requestId,fingerprint,assetId,input.expectedVersion,input.kind,input.name,input.description,
          JSON.stringify(input.tags),input.visibility,input.publication.contentHash,input.publication.manifest.license,
          JSON.stringify(input.publication),input.changeSummary,new Date().toISOString()).run();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (error.message.includes('cloud:idempotency_conflict')) throw new CloudError(409, 'idempotency_conflict', 'Request ID was already used for a different publication');
      if (error.message.includes('cloud:version_conflict')) throw new CloudError(409, 'version_conflict', 'Published version changed; reload before publishing');
      if (error.message.includes('cloud:not_owner')) throw new CloudError(403, 'not_owner', 'Only the owner can update an asset');
      throw error;
    }
    const row = await this.db.prepare(`SELECT asset_id, result_version, result_changed, content_hash
      FROM cloud_publish_requests WHERE user_id=? AND request_id=?`).bind(user.userId,input.requestId)
      .first<{asset_id:string;result_version:number;result_changed:number;content_hash:string}>();
    if (!row) throw new Error('Publication receipt missing after atomic command');
    return { assetId: row.asset_id, version: row.result_version, contentHash: row.content_hash, changed: row.result_changed === 1 };
  }
  async search(userId: string | null, query: string, cursor: string, view: string, kind: LibraryKindFilter = 'all') {
    const args: (string | number | null)[] = [userId];
    let sql = `SELECT a.*,u.name AS author_name FROM cloud_assets a JOIN user u ON u.id=a.owner_user_id
      WHERE (a.visibility='public' OR a.owner_user_id=?)`;
    if (view === 'mine') { sql += ' AND a.owner_user_id=?'; args.push(userId); }
    if (view === 'following') {
      sql += ` AND (EXISTS(SELECT 1 FROM cloud_asset_follows f WHERE f.asset_id=a.asset_id AND f.user_id=?)
        OR EXISTS(SELECT 1 FROM cloud_author_follows f WHERE f.author_id=a.owner_user_id AND f.user_id=?))`; args.push(userId,userId);
    }
    if (kind !== 'all') { sql += ' AND a.kind=?'; args.push(kind); }
    for (const term of query.trim().split(/\s+/).filter(Boolean).slice(0, 16)) {
      sql += ' AND (a.name LIKE ? ESCAPE \'\\\' OR a.description LIKE ? ESCAPE \'\\\' OR a.tags_json LIKE ? ESCAPE \'\\\' OR u.name LIKE ? ESCAPE \'\\\')';
      const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`; args.push(pattern,pattern,pattern,pattern);
    }
    if (cursor) {
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')); } catch (error) { if (!(error instanceof Error)) throw error; throw new CloudError(400,'invalid_cursor','Invalid Library cursor'); }
      // Existing unfiltered cursors remain valid. A filtered cursor is scoped
      // to its kind so it cannot skip results after switching the filter.
      if (!Array.isArray(parsed) || (parsed.length !== 4 && parsed.length !== 5) || !parsed.every((v) => typeof v === 'string') ||
          parsed[2] !== query || parsed[3] !== view || (parsed[4] ?? 'all') !== kind)
        throw new CloudError(400,'invalid_cursor','Cursor does not belong to this search');
      sql += ' AND (a.name COLLATE NOCASE > ? OR (a.name COLLATE NOCASE = ? AND a.asset_id > ?))'; args.push(parsed[0]!,parsed[0]!,parsed[1]!);
    }
    sql += ' ORDER BY a.name COLLATE NOCASE,a.asset_id LIMIT 31';
    const result = await this.db.prepare(sql).bind(...args).all<AssetRow>();
    const rows = result.results.slice(0,30); const last = rows.at(-1);
    return { items: rows.map(summary), nextCursor: result.results.length > 30 && last ? Buffer.from(JSON.stringify([last.name,last.asset_id,query,view,kind]),'utf8').toString('base64url') : null };
  }
  async asset(assetId: string, userId: string | null): Promise<AssetRow> {
    const row = await this.db.prepare(`SELECT a.*,u.name AS author_name FROM cloud_assets a JOIN user u ON u.id=a.owner_user_id
      WHERE a.asset_id=? AND (a.visibility='public' OR a.owner_user_id=?)`).bind(assetId,userId).first<AssetRow>();
    if (!row) throw new CloudError(404,'not_found','Asset not found (legacy assets require explicit conversion)');
    return row;
  }
  async version(assetId: string, version: number, userId: string | null): Promise<VersionRow> {
    await this.asset(assetId,userId);
    const row = await this.db.prepare('SELECT * FROM cloud_versions WHERE asset_id=? AND version=?').bind(assetId,version).first<VersionRow>();
    if (!row) throw new CloudError(404,'not_found','Published version not found');
    return row;
  }
  async versions(assetId: string, userId: string | null) {
    await this.asset(assetId,userId);
    return (await this.db.prepare(`SELECT version,content_hash,created_at,change_summary,
      json_extract(publication_json,'$.manifest.license') AS license FROM cloud_versions WHERE asset_id=? ORDER BY version DESC`)
      .bind(assetId).all<{version:number;content_hash:string;created_at:string;change_summary:string;license:string}>()).results
      .map((row) => ({ version:row.version,contentHash:row.content_hash,createdAt:row.created_at,note:row.change_summary,license:row.license }));
  }
  async metadata(assetId: string, userId: string, input: { name:string;description:string;tags:string[];visibility:string }) {
    const row = await this.asset(assetId,userId);
    if (row.owner_user_id !== userId) throw new CloudError(403,'not_owner','Only the owner can edit metadata');
    await this.db.prepare('UPDATE cloud_assets SET name=?,description=?,tags_json=?,visibility=?,updated_at=? WHERE asset_id=? AND owner_user_id=?')
      .bind(input.name,input.description,JSON.stringify(input.tags),input.visibility,new Date().toISOString(),assetId,userId).run();
    return summary(await this.asset(assetId,userId));
  }
  async deletePublication(assetId: string, userId: string) {
    let row: AssetRow;
    try { row = await this.asset(assetId,userId); }
    catch (error) {
      if (!(error instanceof CloudError) || error.status !== 404) throw error;
      // An owner can retry an accepted DELETE whose response was lost. A
      // retained publish receipt proves ownership without exposing other assets.
      const receipt = await this.db.prepare(`SELECT 1 FROM cloud_publish_requests r WHERE r.asset_id=? AND r.user_id=?
        AND NOT EXISTS(SELECT 1 FROM cloud_assets a WHERE a.asset_id=r.asset_id)`).bind(assetId,userId).first();
      if (!receipt) throw error;
      return {assetId};
    }
    if (row.owner_user_id !== userId) throw new CloudError(403,'not_owner','Only the owner can delete a publication');
    // Versions, likes and asset follows cascade. Keep publish receipts so an
    // old request cannot recreate a deliberately deleted publication.
    await this.db.prepare('DELETE FROM cloud_assets WHERE asset_id=? AND owner_user_id=?').bind(assetId,userId).run();
    return {assetId};
  }
  async relations(assetId:string,userId:string|null) {
    const asset = await this.asset(assetId,userId);
    const row = await this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM cloud_asset_likes WHERE asset_id=?) AS likes,
      EXISTS(SELECT 1 FROM cloud_asset_likes WHERE asset_id=? AND user_id=?) AS liked,
      EXISTS(SELECT 1 FROM cloud_asset_follows WHERE asset_id=? AND user_id=?) AS following,
      EXISTS(SELECT 1 FROM cloud_author_follows WHERE author_id=? AND user_id=?) AS following_author,
      EXISTS(SELECT 1 FROM cloud_asset_follows WHERE asset_id=? AND user_id=? AND followed_version < ?) AS has_update`)
      .bind(assetId,assetId,userId,assetId,userId,asset.owner_user_id,userId,assetId,userId,asset.current_version)
      .first<{likes:number;liked:number;following:number;following_author:number;has_update:number}>();
    return { likes:row!.likes,liked:row!.liked===1,following:row!.following===1,followingAuthor:row!.following_author===1,
      hasUpdate:row!.has_update===1,latestVersion:asset.current_version };
  }
  async relate(assetId:string,userId:string,action:'like'|'follow'|'follow-author',enabled:boolean) {
    const asset = await this.asset(assetId,userId);
    const table = action === 'like' ? 'cloud_asset_likes' : action === 'follow' ? 'cloud_asset_follows' : 'cloud_author_follows';
    const column = action === 'follow-author' ? 'author_id' : 'asset_id';
    const id = action === 'follow-author' ? asset.owner_user_id : assetId;
    if (action === 'follow' && enabled) {
      await this.db.prepare('INSERT INTO cloud_asset_follows(asset_id,user_id,followed_version) VALUES(?,?,?) ON CONFLICT DO NOTHING').bind(assetId,userId,asset.current_version).run();
    } else {
      await this.db.prepare(enabled ? `INSERT INTO ${table}(${column},user_id) VALUES(?,?) ON CONFLICT DO NOTHING` : `DELETE FROM ${table} WHERE ${column}=? AND user_id=?`).bind(id,userId).run();
    }
    return this.relations(assetId,userId);
  }
}
export function summary(row:AssetRow) {
  return { assetId:row.asset_id,kind:row.kind,name:row.name,description:row.description,tags:JSON.parse(row.tags_json) as string[],
    visibility:row.visibility,version:row.current_version,contentHash:row.content_hash,license:row.license,
    author:{id:row.owner_user_id,name:row.author_name},updatedAt:row.updated_at };
}
