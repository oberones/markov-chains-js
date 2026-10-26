import assert from 'node:assert/strict';

const base = new URL(process.argv[2] || 'http://127.0.0.1:8091/');
assert.ok(base.pathname.endsWith('/'), 'Supply a base URL ending in /');
async function request(path, { status = 200, type, immutable = false, method = 'GET' } = {}) {
  const url = new URL(path, base);
  const response = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, status, `${method} ${url}`);
  if (type) assert.match(response.headers.get('content-type') || '', type, path);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN', path);
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', path);
  assert.equal(response.headers.get('cache-control'), immutable ? 'public, max-age=31536000, immutable' : 'no-cache', path);
  return response;
}

const html = await (await request('', { type: /^text\/html/ })).text();
assert.match(html, /Markov Playground/);
await request('index.html', { method: 'HEAD', type: /^text\/html/ });
const assets = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"?#]+)"/g)].map(match => match[1]);
assert.ok(assets.some(path => path.endsWith('.js')), 'Built JS must be linked');
assert.ok(assets.some(path => path.endsWith('.css')), 'Built CSS must be linked');
const types = { js: /^(?:application|text)\/javascript/, css: /^text\/css/, svg: /^image\/svg\+xml/ };
for (const asset of new Set(assets)) {
  const response = await request(asset, { type: types[asset.split('.').pop()], immutable: true });
  assert.ok((await response.arrayBuffer()).byteLength > 0, `${asset} is empty`);
}
const notices = await (await request('THIRD_PARTY_NOTICES.txt', { type: /^text\/plain/ })).text();
assert.match(notices, /fflate/);
assert.match(notices, /midi-file/);
for (const path of ['missing', 'assets/missing.js', '.env', '.git/config', 'package.json', 'src/app/main.js']) {
  await request(path, { status: 404 });
}
await request('index.html', { method: 'POST', status: 403 });
console.log(`Container HTTP checks passed at ${base}`);
