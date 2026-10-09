import { z } from 'zod';
import type { Publication } from '../../contracts/publication.gen.ts';

export class CloudError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status=status; this.code=code; }
}
export const metadataSchema = z.object({
  name: z.string().trim().min(1).max(200), description: z.string().max(20000),
  tags: z.array(z.string().trim().min(1).max(80)).max(32),
  visibility: z.enum(['public', 'private']),
}).strict();
export const publishSchema = metadataSchema.extend({
  requestId: z.string().min(1).max(128), assetId: z.string().min(1).max(128).nullable(),
  expectedVersion: z.number().int().nonnegative(), kind: z.enum(['graph', 'component', 'variant']),
  changeSummary: z.string().max(2000), publication: z.unknown(),
}).strict();
export type PublishInput = Omit<z.infer<typeof publishSchema>, 'publication'> & { publication: Publication };
export interface CloudUser { userId: string; name: string }
export interface AssetRow {
  asset_id: string; owner_user_id: string; author_name: string; kind: 'graph' | 'component' | 'variant';
  name: string; description: string; tags_json: string; visibility: 'public' | 'private';
  current_version: number; content_hash: string; license: string; updated_at: string;
}
export interface VersionRow { version: number; content_hash: string; publication_json: string; created_at: string; change_summary: string }
