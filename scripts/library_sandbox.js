// Persistent, local-only Library acceptance environment. Never deployed.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createSqliteD1Database } from '../test_support/sqlite_d1_adapter.js';
import { startHttpWorker } from '../test_support/http_worker.js';
import { hashAuthPassword } from '../src/password.js';

const { values } = parseArgs({ options: {
  port: { type: 'string', default: '8787' },
  'data-dir': { type: 'string', default: fileURLToPath(new URL('../.wrangler/library-sandbox', import.meta.url)) },
} });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be between 0 and 65535');
const dataDir = path.resolve(values['data-dir']);
fs.mkdirSync(dataDir, { recursive: true });
const db = createSqliteD1Database({ migrationsSql: '', databasePath: path.join(dataDir, 'library.sqlite') });
db.exec('CREATE TABLE IF NOT EXISTS sandbox_migrations(name TEXT PRIMARY KEY)');
for (const name of fs.readdirSync(new URL('../migrations', import.meta.url)).filter((name) => name.endsWith('.sql')).sort()) {
  if (await db.prepare('SELECT name FROM sandbox_migrations WHERE name=?').bind(name).first()) continue;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    await db.prepare('INSERT INTO sandbox_migrations(name) VALUES(?)').bind(name).run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
const secretPath = path.join(dataDir, 'auth-secret');
if (!fs.existsSync(secretPath)) fs.writeFileSync(secretPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
const accounts = [
  { id: 'sandbox-author', name: 'Sandbox author', email: 'author@sandbox.test' },
  { id: 'sandbox-reader', name: 'Sandbox reader', email: 'reader@sandbox.test' },
];
for (const account of accounts) {
  if (await db.prepare('SELECT id FROM user WHERE id=?').bind(account.id).first()) continue;
  const timestamp = Date.now();
  const password = await hashAuthPassword('sandbox-password');
  db.exec('BEGIN IMMEDIATE');
  try {
    await db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,role) VALUES(?,?,?,1,?,?,?)')
      .bind(account.id, account.name, account.email, timestamp, timestamp, 'user').run();
    await db.prepare('INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)')
      .bind(`${account.id}-credential`, account.id, 'credential', account.id, password, timestamp, timestamp).run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
const env = { DB: db, AUTH_BASE_URL: '', BETTER_AUTH_SECRET: fs.readFileSync(secretPath, 'utf8') };
const server = await startHttpWorker(env, port);
console.log(`Feel8 Cloud local sandbox: ${env.AUTH_BASE_URL}\nData: ${dataDir}\n` +
  'Accounts: author@sandbox.test / reader@sandbox.test\nPassword for both: sandbox-password\n' +
  'Use this Cloud URL in Studio Assets. Data survives restart. Press Ctrl+C to stop.');
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  server.close(() => { db.close(); });
  server.closeIdleConnections();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
