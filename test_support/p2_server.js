// Isolated HTTP harness for Studio integration/Playwright. In-memory SQLite uses
// every real migration and the production Worker/auth routes. Never deployed.
import fs from 'node:fs';
import { startHttpWorker } from './http_worker.js';
import { createSqliteD1Database } from './sqlite_d1_adapter.js';
import { hashAuthPassword } from '../src/password.js';
const migrations=fs.readdirSync(new URL('../migrations',import.meta.url)).filter((f)=>f.endsWith('.sql')).sort()
  .map((f)=>fs.readFileSync(new URL(`../migrations/${f}`,import.meta.url),'utf8')).join('\n');
const env={DB:createSqliteD1Database({migrationsSql:migrations}),BETTER_AUTH_SECRET:'p2-test-secret-0123456789abcdef0123456789',
  BOOTSTRAP_ADMIN_USERNAME:'p2author',BOOTSTRAP_ADMIN_DISPLAY_NAME:'P2 Author',BOOTSTRAP_ADMIN_EMAIL:'p2@example.com',
  BOOTSTRAP_ADMIN_PASSWORD:'p2-only-password',AUTH_BASE_URL:''};
// A second verified ordinary account exercises ownership through real login.
const readerId='p2-library-reader';const timestamp=Date.now();
await env.DB.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,role) VALUES(?,?,?,1,?,?,?)')
  .bind(readerId,'Library reader','library-reader@example.com',timestamp,timestamp,'user').run();
await env.DB.prepare('INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)')
  .bind('p2-reader-account',readerId,'credential',readerId,await hashAuthPassword('reader-password'),timestamp,timestamp).run();
await startHttpWorker(env);
process.stdout.write(JSON.stringify({baseUrl:env.AUTH_BASE_URL})+'\n');
