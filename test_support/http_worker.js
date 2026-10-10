import { createServer } from 'node:http';
import { createApp } from '../src/app.js';

// Both integration tests and the local sandbox use the production HTTP routes.
// Bind only to loopback; no Cloudflare account or remote database is involved.
export async function startHttpWorker(env, port = 0) {
  const app = createApp();
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const request = new Request(env.AUTH_BASE_URL + req.url, {
        method: req.method, headers: req.headers,
        ...(body.length ? { body, duplex: 'half' } : {}),
      });
      const response = await app.fetch(request, env, {});
      res.statusCode = response.status;
      for (const [name, value] of response.headers) if (name !== 'set-cookie') res.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('Set-Cookie', cookies);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(`Local Cloud request failed: ${req.method} ${req.url}`, error);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: 'Local Cloud request failed; see the server terminal' }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Local Cloud has no TCP address');
  env.AUTH_BASE_URL = `http://127.0.0.1:${address.port}`;
  return server;
}
