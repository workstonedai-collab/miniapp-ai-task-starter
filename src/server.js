// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 workstonedai-collab
import http from 'node:http';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TaskService } from './service.js';

export function createServer(service = new TaskService('.state')) {
  const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
  return http.createServer(async (request, response) => {
    const reply = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
    try {
      const port = request.socket.localPort, allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowed.includes(request.headers.host)) return reply(403, { error: 'LOCAL_ONLY' });
      const origin = request.headers.origin;
      if (origin && !allowed.map(host => 'http://' + host).includes(origin)) return reply(403, { error: 'ORIGIN_REJECTED' });
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && assets[url.pathname]) {
        const [name, type] = assets[url.pathname];
        response.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'" });
        return response.end(await fs.readFile(new URL('../public/' + name, import.meta.url)));
      }
      const match = url.pathname.match(/^\/tasks\/(job_[a-f0-9]{32})(?:\/(retry|result))?$/);
      if (request.method === 'GET' && match) return reply(200, await (match[2] === 'result' ? service.result(match[1]) : service.progress(match[1])));
      if (request.method !== 'POST' || request.headers['x-task-demo'] !== '1') return reply(403, { error: 'WRITE_HEADER_REQUIRED' });
      if (url.pathname === '/tasks') {
        let body = '';
        for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 8192) return reply(413, { error: 'INPUT_TOO_LARGE' }); }
        return reply(202, await service.create(JSON.parse(body)));
      }
      if (match?.[2] === 'retry') return reply(202, await service.retry(match[1]));
      reply(404, { error: 'NOT_FOUND' });
    } catch (error) {
      const code = error.code || (error instanceof SyntaxError ? 'INVALID_INPUT' : 'LOCAL_IO');
      const safe = ['INVALID_INPUT', 'CONFLICT', 'NOT_READY', 'ENOENT'].includes(code) ? code : 'LOCAL_IO';
      reply(safe === 'ENOENT' ? 404 : safe === 'CONFLICT' || safe === 'NOT_READY' ? 409 : 400, { error: safe });
    }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer(); server.listen(4198, '127.0.0.1', () => console.log('Fictional local task demo: http://127.0.0.1:4198'));
}
