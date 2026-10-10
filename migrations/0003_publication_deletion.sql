-- Keep only retry receipts after a publication is deleted. Stored command
-- payloads must not retain the removed graph/component or listing text.
CREATE TRIGGER cloud_publication_delete_receipts AFTER DELETE ON cloud_assets
BEGIN
  UPDATE cloud_publish_requests SET
    name='', description='', tags_json='[]', license='', publication_json='{}', change_summary=''
    WHERE asset_id=OLD.asset_id;
END;
