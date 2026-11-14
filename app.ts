// app.ts — the HTTP front door: one node:http server, no dependencies.
// Routes:
//   GET  /healthz                  -> {"ok": true}
//   /api/v3/*                      -> REST v3 (Bearer auth, JSON)
//   POST /api/graphql              -> GraphQL v4 (Bearer auth, JSON)
//   POST /mcp                      -> MCP Streamable HTTP (Bearer auth, JSON)
//   /{owner}/{repo}.git/*          -> git smart HTTP (no auth)
//   anything else                  -> 404 JSON
// Every reply carries a non-empty X-GitHub-Request-Id. One bad request never
// kills the server: each handler is wrapped in its own try/catch.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';

export interface AppOptions {
  /** The bearer token the env gave us (MAKEFUN_SHOP_TOKEN). Empty = no auth enforced. */
  token: string;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function jsonResponse(res: ServerResponse, requestId: string, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId,
    'content-length': Buffer.byteLength(text, 'utf8'),
    ...extraHeaders,
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(store: Store, options: AppOptions): Server {
  const token = options.token;
  let requestCounter = 0;

  const server = createServer((req, res) => {
    const requestId = `req-${(requestCounter += 1)}`;
    void (async () => {
      try {
        const method = (req.method ?? 'GET').toUpperCase();
        const rawUrl = req.url ?? '/';
        const url = new URL(rawUrl, 'http://127.0.0.1');
        const pathname = url.pathname;
        const host = req.headers.host ?? '127.0.0.1';
        const origin = `http://${host}`;

        // -- health ---------------------------------------------------------
        if (pathname === '/healthz') {
          jsonResponse(res, requestId, 200, { ok: true });
          return;
        }

        // -- auth helper ----------------------------------------------------
        const authorized = (): boolean => {
          if (token === '') return true;
          const header = req.headers.authorization ?? '';
          return header === `Bearer ${token}`;
        };
        const needAuth = (): boolean => {
          if (authorized()) return true;
          jsonResponse(res, requestId, 401, { message: 'Bad credentials' });
          return false;
        };

        // -- git smart HTTP (no auth) ---------------------------------------
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(pathname);
        if (gitMatch !== null) {
          const owner = decodeSegment(gitMatch[1]);
          const repoName = decodeSegment(gitMatch[2]);
          const tail = gitMatch[3];
          const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          if (method === 'GET' && tail === 'info/refs') {
            const service = url.searchParams.get('service') ?? '';
            const result = handleInfoRefs(store, owner, repoName, service, wantsV2);
            res.writeHead(result.status, {
              'content-type': result.contentType,
              'x-github-request-id': requestId,
              'content-length': result.body.length,
            });
            res.end(result.body);
            return;
          }
          if (method === 'POST' && tail === 'git-upload-pack') {
            const body = await readBody(req);
            const result = handleUploadPack(store, owner, repoName, body, wantsV2);
            res.writeHead(result.status, {
              'content-type': result.contentType,
              'x-github-request-id': requestId,
              'content-length': result.body.length,
            });
            res.end(result.body);
            return;
          }
          if (method === 'POST' && tail === 'git-receive-pack') {
            const body = await readBody(req);
            const result = handleReceivePack(store, owner, repoName, body);
            res.writeHead(result.status, {
              'content-type': result.contentType,
              'x-github-request-id': requestId,
              'content-length': result.body.length,
            });
            res.end(result.body);
            return;
          }
          jsonResponse(res, requestId, 404, { message: 'Not Found' });
          return;
        }

        // -- MCP ------------------------------------------------------------
        if (pathname === '/mcp') {
          if (method === 'DELETE') {
            // A legacy session close: nothing is held, acknowledge it.
            res.writeHead(204, { 'x-github-request-id': requestId });
            res.end();
            return;
          }
          if (method !== 'POST') {
            jsonResponse(res, requestId, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!needAuth()) return;
          const raw = await readBody(req);
          const answer = handleMcp(store, raw.toString('utf8'));
          if (answer.body === '') {
            res.writeHead(answer.status, { 'x-github-request-id': requestId });
            res.end();
            return;
          }
          res.writeHead(answer.status, {
            'content-type': 'application/json; charset=utf-8',
            'x-github-request-id': requestId,
            'content-length': Buffer.byteLength(answer.body, 'utf8'),
          });
          res.end(answer.body);
          return;
        }

        // -- GraphQL --------------------------------------------------------
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            jsonResponse(res, requestId, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!needAuth()) return;
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
          } catch {
            jsonResponse(res, requestId, 400, { message: 'Problems parsing JSON' });
            return;
          }
          const result = handleGraphQL(store, parsed);
          jsonResponse(res, requestId, result.status, result.body);
          return;
        }

        // -- REST v3 --------------------------------------------------------
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          if (!needAuth()) return;
          const tail = pathname.slice('/api/v3'.length);
          const segments = tail.split('/').filter((s) => s !== '').map(decodeSegment);
          let body: unknown = undefined;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                body = JSON.parse(raw.toString('utf8'));
              } catch {
                jsonResponse(res, requestId, 400, { message: 'Problems parsing JSON' });
                return;
              }
            }
          }
          const result = handleRest({ store, method, segments, query: url.searchParams, body, origin, path: pathname });
          jsonResponse(res, requestId, result.status, result.body, result.headers ?? {});
          return;
        }

        // -- anything else --------------------------------------------------
        jsonResponse(res, requestId, 404, { message: 'Not Found' });
      } catch (err) {
        try {
          jsonResponse(res, requestId, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is already gone; nothing more to do.
        }
        void err;
      }
    })();
  });

  return server;
}
