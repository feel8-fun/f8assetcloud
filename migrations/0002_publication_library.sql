-- New portable assets are separate from legacy blobs. No legacy row is rewritten.
CREATE TABLE cloud_assets (
  asset_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES user(id),
  kind TEXT NOT NULL CHECK(kind IN ('graph','component','variant')),
  name TEXT NOT NULL, description TEXT NOT NULL, tags_json TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('public','private')),
  current_version INTEGER NOT NULL, content_hash TEXT NOT NULL, license TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX cloud_assets_catalog ON cloud_assets(visibility, name COLLATE NOCASE, asset_id);
CREATE INDEX cloud_assets_owner ON cloud_assets(owner_user_id, updated_at DESC, asset_id);
CREATE TABLE cloud_versions (
  asset_id TEXT NOT NULL REFERENCES cloud_assets(asset_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0), content_hash TEXT NOT NULL,
  publication_json TEXT NOT NULL, created_at TEXT NOT NULL, change_summary TEXT NOT NULL,
  PRIMARY KEY(asset_id,version)
);
CREATE TRIGGER cloud_versions_immutable BEFORE UPDATE ON cloud_versions
BEGIN SELECT RAISE(ABORT,'cloud:immutable_version'); END;
CREATE TABLE cloud_publish_requests (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, asset_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL, kind TEXT NOT NULL,
  name TEXT NOT NULL, description TEXT NOT NULL, tags_json TEXT NOT NULL, visibility TEXT NOT NULL,
  content_hash TEXT NOT NULL, license TEXT NOT NULL, publication_json TEXT NOT NULL,
  change_summary TEXT NOT NULL, created_at TEXT NOT NULL,
  result_version INTEGER, result_changed INTEGER,
  PRIMARY KEY(user_id, request_id)
);
-- One INSERT executes all checks and writes atomically, even on D1. No read/write
-- transaction emulation and no dependent client-side batches.
CREATE TRIGGER cloud_publish_validate BEFORE INSERT ON cloud_publish_requests
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM cloud_publish_requests
    WHERE user_id=NEW.user_id AND request_id=NEW.request_id AND fingerprint!=NEW.fingerprint)
    THEN RAISE(ABORT,'cloud:idempotency_conflict') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cloud_publish_requests WHERE user_id=NEW.user_id AND request_id=NEW.request_id)
    AND NEW.expected_version > 0 AND NOT EXISTS(SELECT 1 FROM cloud_assets WHERE asset_id=NEW.asset_id AND owner_user_id=NEW.user_id)
    THEN RAISE(ABORT,'cloud:not_owner') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cloud_publish_requests WHERE user_id=NEW.user_id AND request_id=NEW.request_id)
    AND NEW.expected_version > 0 AND NOT EXISTS(SELECT 1 FROM cloud_assets
      WHERE asset_id=NEW.asset_id AND current_version=NEW.expected_version AND kind=NEW.kind)
    THEN RAISE(ABORT,'cloud:version_conflict') END;
END;
CREATE TRIGGER cloud_publish_apply AFTER INSERT ON cloud_publish_requests
BEGIN
  INSERT INTO cloud_assets(asset_id,owner_user_id,kind,name,description,tags_json,visibility,current_version,content_hash,license,created_at,updated_at)
    SELECT NEW.asset_id,NEW.user_id,NEW.kind,NEW.name,NEW.description,NEW.tags_json,NEW.visibility,1,NEW.content_hash,NEW.license,NEW.created_at,NEW.created_at
    WHERE NEW.expected_version=0;
  UPDATE cloud_assets SET
    current_version=current_version + CASE WHEN content_hash!=NEW.content_hash THEN 1 ELSE 0 END,
    updated_at= CASE WHEN content_hash!=NEW.content_hash THEN NEW.created_at ELSE updated_at END,
    content_hash=NEW.content_hash, license=NEW.license
    WHERE asset_id=NEW.asset_id AND NEW.expected_version>0;
  INSERT INTO cloud_versions(asset_id,version,content_hash,publication_json,created_at,change_summary)
    SELECT NEW.asset_id,current_version,NEW.content_hash,NEW.publication_json,NEW.created_at,NEW.change_summary
    FROM cloud_assets WHERE asset_id=NEW.asset_id
    ON CONFLICT(asset_id,version) DO NOTHING;
  UPDATE cloud_publish_requests SET
    result_version=(SELECT current_version FROM cloud_assets WHERE asset_id=NEW.asset_id),
    result_changed= CASE WHEN NEW.expected_version=0 OR NEW.expected_version < (SELECT current_version FROM cloud_assets WHERE asset_id=NEW.asset_id) THEN 1 ELSE 0 END
    WHERE user_id=NEW.user_id AND request_id=NEW.request_id;
END;
CREATE TABLE cloud_asset_likes (
  asset_id TEXT NOT NULL REFERENCES cloud_assets(asset_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  PRIMARY KEY(asset_id,user_id)
);
CREATE TABLE cloud_asset_follows (
  asset_id TEXT NOT NULL REFERENCES cloud_assets(asset_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  followed_version INTEGER NOT NULL,
  PRIMARY KEY(asset_id,user_id)
);
CREATE TABLE cloud_author_follows (
  author_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  PRIMARY KEY(author_id,user_id)
);
