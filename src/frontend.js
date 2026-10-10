import { jsonResponse } from './common/http.js';

const PORTAL_STATIC_DIR = '/_portal';

function frontendFallbackResponse() {
  return new Response(buildPortalFallbackHtml(), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function serveFrontend(request, env, url) {
  if (!isPortalStaticAssetPath(url.pathname) && url.pathname !== '/favicon.ico' && !isPortalAppPath(url.pathname)) {
    return jsonResponse(404, { message: 'not found' });
  }

  const assets = getAssetsBinding(env);
  if (assets === null) {
    if (isPortalStaticAssetPath(url.pathname) || url.pathname === '/favicon.ico') {
      return jsonResponse(404, { message: 'not found' });
    }
    return frontendFallbackResponse();
  }

  let assetPath = '/';
  if (isPortalStaticAssetPath(url.pathname)) {
    assetPath = url.pathname;
  } else if (url.pathname === '/favicon.ico') {
    assetPath = '/favicon.ico';
  }

  const assetRequest = new Request(new URL(assetPath, 'https://assets.invalid'), request);
  return assets.fetch(assetRequest);
}

function isPortalAppPath(pathname) {
  const normalizedPath = String(pathname || '');
  if (normalizedPath === '/') {
    return true;
  }
  const exactRoutes = new Set([
    '/login',
    '/register',
    '/forgot-password',
    '/reset-password',
    '/verify-email',
    '/auth-callback',
    '/auth-complete',
    '/auth-error',
    '/browse',
    '/profile',
  ]);
  if (exactRoutes.has(normalizedPath)) {
    return true;
  }
  return normalizedPath.startsWith('/assets/') || normalizedPath.startsWith('/admin/');
}

function isPortalStaticAssetPath(pathname) {
  if (!pathname.startsWith(`${PORTAL_STATIC_DIR}/`)) {
    return false;
  }
  const lastSegment = pathname.split('/').pop() || '';
  return /\.[a-z0-9]+$/i.test(lastSegment);
}

function getAssetsBinding(env) {
  if (!env || typeof env !== 'object') {
    return null;
  }
  const assets = env.ASSETS;
  if (assets && typeof assets.fetch === 'function') {
    return assets;
  }
  return null;
}

function buildPortalFallbackHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Feel8 Asset Cloud</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #0c1220; color: #edf2ff; }
      main { max-width: 760px; margin: 48px auto; padding: 24px; border: 1px solid #30456b; border-radius: 12px; background: #121c31; }
      h1 { margin-top: 0; }
      code { background: #0b1426; padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Feel8 Asset Cloud</h1>
      <p>Frontend assets are not available yet.</p>
      <p>Build the Vite app first:</p>
      <p><code>npm run web:build</code></p>
      <p>Then open <code>/</code> in the browser.</p>
    </main>
  </body>
</html>`;
}
