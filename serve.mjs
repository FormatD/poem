#!/usr/bin/env node
/**
 * 零依赖静态服务器：托管 public/，并把 /api/* 代理到本地诗词 API。
 * 走代理而不是直连 1279，是为了让页面与 API 同源，
 * 免去 CORS 预检，也便于把 API 换端口或放到反代后面。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT || 5279);
const API = (process.env.POETRY_API || 'http://127.0.0.1:1279').replace(/\/$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function proxy(req, res, url) {
  try {
    const upstream = await fetch(API + url, {
      headers: { accept: req.headers.accept || 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `诗词 API 不可达（${API}）: ${err.message}` }));
  }
}

async function serveStatic(res, pathname) {
  let file = path.join(ROOT, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; } // Path traversal
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': file.includes('/data/') ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<p>404</p>');
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) return proxy(req, res, url.pathname + url.search);
  await serveStatic(res, url.pathname);
}).listen(PORT, () => {
  console.log(`诗词闯关: http://localhost:${PORT}`);
  console.log(`API 代理  : /api/* → ${API}`);
});
