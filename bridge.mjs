import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createCdpRelayConnection } from './cdp-relay.mjs';

const MAX_WS_PAYLOAD = 64 * 1024 * 1024;
const MAX_JSON_BODY = 64 * 1024;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

function defaultLog(event, details = {}) {
  if (process.env.T3_BRAVE_QUIET === '1') return;
  const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  console.log(`[${new Date().toISOString()}] [t3-brave-bridge] ${event}${suffix}`);
}

async function readJsonBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_JSON_BODY) throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }); }
}

// This bridge never opens a browser profile or reads cookies. Only explicitly
// shared tabs (or tabs opened on user-allowlisted domains) become CDP targets.
export async function createBridge({
  token,
  port = 9334,
  commandTimeout,
  reconnectGrace = 10000,
  heartbeatInterval = 30000,
  seedAllowlist = [],
  log = defaultLog,
} = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('A pairing token of at least 32 characters is required');
  const targets = new Map();
  const clients = new Map();
  const pending = new Map();
  const relays = new Map();
  const contextsByTarget = new Map();
  const runtimeEnabledTargets = new Set();
  const runtimeEnableInFlight = new Map();
  let extension;
  let extensionAllowlist = [];
  let heartbeatTimer;
  let graceTimer;
  let lastDisconnect;
  let lastDetach;
  let sequence = 0;

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
  const validToken = value => {
    const a = Buffer.from(value ?? ''), b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const authenticate = (req, url) => validToken(req.headers.authorization?.replace(/^Bearer /, '') ?? url.searchParams.get('token'));
  const send = (socket, value) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };

  const clearPending = message => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(message)); }
    pending.clear();
  };
  const clearRuntimeState = targetId => {
    if (targetId === undefined) {
      contextsByTarget.clear();
      runtimeEnabledTargets.clear();
      runtimeEnableInFlight.clear();
    } else {
      contextsByTarget.delete(targetId);
      runtimeEnabledTargets.delete(targetId);
      runtimeEnableInFlight.delete(targetId);
    }
  };
  const closeTargetClients = (targetId, code, reason) => {
    for (const client of clients.get(targetId) ?? []) client.close(code, reason);
    clients.delete(targetId);
    relays.delete(targetId);
    clearRuntimeState(targetId);
  };
  const handleExtensionDisconnect = (code, reason) => {
    clearInterval(heartbeatTimer); heartbeatTimer = undefined;
    clearPending('Brave extension disconnected');
    for (const group of clients.values()) for (const socket of group) socket.close(1011, 'Brave extension disconnected');
    clients.clear();
    relays.clear();
    clearRuntimeState();
    lastDisconnect = { at: new Date().toISOString(), code, reason };
    log('extension.disconnected', { code, reason, preservedTargets: reconnectGrace > 0 ? targets.size : 0 });
    clearTimeout(graceTimer); graceTimer = undefined;
    if (reconnectGrace > 0 && targets.size > 0) {
      graceTimer = setTimeout(() => {
        graceTimer = undefined;
        if (extension?.readyState !== WebSocket.OPEN && targets.size > 0) {
          const expired = targets.size;
          targets.clear();
          log('targets.expired', { expired });
        }
      }, reconnectGrace);
      graceTimer.unref?.();
    } else {
      targets.clear();
    }
  };

  const timeoutFor = (method, params) => {
    if (commandTimeout !== undefined) return commandTimeout;
    if (method === 'bridge.openTab' || method === 'Page.navigate' || method === 'Page.reload' || (method?.startsWith('Runtime.') && params?.awaitPromise)) return 60000;
    return 15000;
  };
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (extension?.readyState !== WebSocket.OPEN) return reject(new Error('Brave extension is not connected'));
    const id = ++sequence;
    const ms = timeoutFor(params?.method ?? method, params?.params);
    const timer = setTimeout(() => {
      pending.delete(id);
      log('command.timeout', { method: params?.method ?? method, targetId: params?.targetId, timeoutMs: ms });
      reject(new Error(`Brave command timed out: ${params?.method ?? method}`));
    }, ms);
    pending.set(id, { resolve, reject, timer });
    send(extension, { id, method, params });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const origin = req.headers.origin;
    res.setHeader('Cache-Control', 'no-store');
    if ((origin && !EXTENSION_ORIGIN.test(origin)) || !authenticate(req, url)) {
      res.writeHead(401); return res.end('Unauthorized');
    }
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'POST' && (url.pathname === '/tabs/open' || url.pathname === '/tabs/close')) {
      try {
        const body = await readJsonBody(req);
        if (url.pathname === '/tabs/open') {
          if (typeof body.url !== 'string' || !body.url.trim()) {
            res.writeHead(400); return res.end(JSON.stringify({ error: 'url is required' }));
          }
          const opened = await request('bridge.openTab', {
            url: body.url.trim(),
            reuse: body.reuse ?? true,
            active: Boolean(body.active),
          });
          log('tab.opened', { targetId: opened?.targetId, reused: Boolean(opened?.reused) });
          res.writeHead(200); return res.end(JSON.stringify(opened));
        }
        if (typeof body.targetId !== 'string' || !body.targetId.trim()) {
          res.writeHead(400); return res.end(JSON.stringify({ error: 'targetId is required' }));
        }
        const closed = await request('bridge.closeTab', { targetId: body.targetId.trim() });
        log('tab.closed', { targetId: body.targetId.trim() });
        res.writeHead(200); return res.end(JSON.stringify(closed));
      } catch (error) {
        const status = error.statusCode ?? (/not in the .*allowlist|only agent-opened|not shared|http/i.test(error.message) ? 403 : 502);
        res.writeHead(status);
        return res.end(JSON.stringify({ error: error.message }));
      }
    }

    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    if (url.pathname === '/status') {
      return res.end(JSON.stringify({
        connected: extension?.readyState === WebSocket.OPEN,
        targets: [...targets.values()],
        ...(extensionAllowlist.length ? { allowlist: extensionAllowlist } : {}),
        ...(lastDisconnect ? { lastDisconnect } : {}),
        ...(lastDetach ? { lastDetach } : {}),
      }));
    }
    if (url.pathname === '/json' || url.pathname === '/json/list') {
      const address = server.address();
      return res.end(JSON.stringify([...targets.values()].map(info => ({ ...info, id: info.targetId, type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/page/${encodeURIComponent(info.targetId)}?token=${encodeURIComponent(token)}` }))));
    }
    res.writeHead(404); res.end();
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const origin = req.headers.origin;
    const isExtensionPath = url.pathname === '/extension';
    const isExtensionOrigin = typeof origin === 'string' && EXTENSION_ORIGIN.test(origin);

    // Web pages cannot use the local bridge, even if they guess its URL.
    // /extension additionally requires a chrome-extension:// origin before authentication succeeds.
    if ((isExtensionPath && !isExtensionOrigin) || (origin && !isExtensionOrigin) || !authenticate(req, url)) {
      log('ws.rejected', { path: url.pathname, hasOrigin: Boolean(origin) });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }

    const match = /^\/devtools\/page\/([^/]+)$/.exec(url.pathname);
    let decodedTarget;
    try { decodedTarget = match && decodeURIComponent(match[1]); } catch { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.destroy(); }
    if (!isExtensionPath && (!match || !targets.has(decodedTarget))) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy(); }
    const targetId = decodedTarget;

    wss.handleUpgrade(req, socket, head, ws => {
      if (isExtensionPath) {
        const previous = extension;
        extension = ws;
        clearTimeout(graceTimer); graceTimer = undefined;
        clearInterval(heartbeatTimer); heartbeatTimer = undefined;
        if (previous && previous !== ws) {
          log('extension.replaced', {});
          previous.close(1000, 'Replaced by newer extension connection');
        }
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        log('extension.connected', {});
        if (Array.isArray(seedAllowlist) && seedAllowlist.length) {
          send(ws, { method: 'bridge.seedAllowlist', params: { allowlist: seedAllowlist } });
        }
        if (heartbeatInterval > 0) {
          heartbeatTimer = setInterval(() => {
            if (extension !== ws) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; return; }
            if (!ws.isAlive) {
              log('extension.heartbeat_timeout', {});
              ws.terminate();
              return;
            }
            ws.isAlive = false;
            ws.ping();
          }, heartbeatInterval);
          heartbeatTimer.unref?.();
        }
        ws.on('close', (code, reasonBuffer) => {
          if (extension === ws) {
            extension = undefined;
            handleExtensionDisconnect(code, String(reasonBuffer || ''));
          }
        });
        ws.on('message', data => {
          ws.isAlive = true;
          let message; try { message = JSON.parse(String(data)); } catch { return ws.close(1008, 'Invalid JSON'); }
          if (message.id !== undefined) {
            const waiter = pending.get(message.id); if (!waiter) return;
            clearTimeout(waiter.timer); pending.delete(message.id);
            if (message.error) waiter.reject(new Error(message.error.message ?? 'CDP command failed')); else waiter.resolve(message.result ?? {});
          } else if (message.method === 'bridge.ping') {
            send(ws, { method: 'bridge.pong' });
          } else if (message.method === 'bridge.pong') {
            // Liveness already refreshed above.
          } else if (message.method === 'bridge.config') {
            if (Array.isArray(message.params?.allowlist)) {
              extensionAllowlist = message.params.allowlist.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim());
            }
          } else if (message.method === 'bridge.detach') {
            lastDetach = { at: new Date().toISOString(), targetId: message.params?.targetId, reason: message.params?.reason ?? 'unknown' };
            log('tab.detached', lastDetach);
          } else if (message.method === 'bridge.targetReset') {
            const resetId = message.params?.targetId;
            const reason = message.params?.reason ?? 'CDP payload too large';
            log('target.reset', { targetId: resetId, reason });
            if (typeof resetId === 'string') closeTargetClients(resetId, 1009, reason);
          } else if (message.method === 'bridge.targets') {
            clearTimeout(graceTimer); graceTimer = undefined;
            if (Array.isArray(message.params?.allowlist)) {
              extensionAllowlist = message.params.allowlist.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim());
            }
            const next = new Map((Array.isArray(message.params?.targets) ? message.params.targets : []).filter(t => typeof t.targetId === 'string' && t.type === 'page').map(t => [t.targetId, t]));
            for (const id of targets.keys()) if (!next.has(id)) {
              log('target.removed', { targetId: id });
              closeTargetClients(id, 1000, 'Tab detached');
            }
            targets.clear(); for (const [id, info] of next) targets.set(id, info);
          } else if (message.method === 'bridge.event') {
            const { targetId: eventTargetId, method, params, sessionId } = message.params ?? {};
            if (targets.has(eventTargetId) && typeof method === 'string') {
              if (!sessionId) {
                if (method === 'Runtime.executionContextCreated' && params?.context?.id !== undefined) {
                  if (!contextsByTarget.has(eventTargetId)) contextsByTarget.set(eventTargetId, new Map());
                  contextsByTarget.get(eventTargetId).set(params.context.id, params.context);
                } else if (method === 'Runtime.executionContextDestroyed' && params?.executionContextId !== undefined) {
                  contextsByTarget.get(eventTargetId)?.delete(params.executionContextId);
                } else if (method === 'Runtime.executionContextsCleared') {
                  contextsByTarget.get(eventTargetId)?.clear();
                }
              }
              for (const relay of relays.get(eventTargetId) ?? []) relay.event(method, params, sessionId);
            }
          }
        });
      } else {
        if (!clients.has(targetId)) clients.set(targetId, new Set());
        clients.get(targetId).add(ws);
        const info = targets.get(targetId);
        const relay = createCdpRelayConnection({
          targetId: async () => targetId,
          url: () => targets.get(targetId)?.url ?? info.url ?? '',
          title: () => targets.get(targetId)?.title ?? info.title ?? '',
          userAgent: () => info.userAgent ?? 'Mozilla/5.0 Chrome/156.0.0.0',
          setDownloadDirectory: () => {}, // Brave keeps downloads in its own configured directory.
          send: (method, params, sessionId) => request('bridge.command', { targetId, method, params, ...(sessionId ? { sessionId } : {}) }),
          runtimeEnable: async (emitEvent) => {
            if (runtimeEnabledTargets.has(targetId)) {
              const cached = [...(contextsByTarget.get(targetId)?.values() ?? [])];
              queueMicrotask(() => {
                for (const context of cached) emitEvent('Runtime.executionContextCreated', { context });
              });
              return {};
            }
            let inflight = runtimeEnableInFlight.get(targetId);
            if (!inflight) {
              const isSoleClient = (relays.get(targetId)?.size ?? 0) <= 1;
              inflight = (async () => {
                if (isSoleClient) {
                  await request('bridge.command', { targetId, method: 'Runtime.disable', params: {} }).catch(() => undefined);
                  contextsByTarget.get(targetId)?.clear();
                }
                const result = await request('bridge.command', { targetId, method: 'Runtime.enable', params: {} });
                runtimeEnabledTargets.add(targetId);
                return result;
              })().finally(() => { runtimeEnableInFlight.delete(targetId); });
              runtimeEnableInFlight.set(targetId, inflight);
              return inflight;
            }
            await inflight;
            const cached = [...(contextsByTarget.get(targetId)?.values() ?? [])];
            queueMicrotask(() => {
              for (const context of cached) emitEvent('Runtime.executionContextCreated', { context });
            });
            return {};
          },
          runtimeDisable: async () => {
            if ((relays.get(targetId)?.size ?? 0) > 1) return {};
            runtimeEnabledTargets.delete(targetId);
            contextsByTarget.delete(targetId);
            return request('bridge.command', { targetId, method: 'Runtime.disable', params: {} });
          },
        }, raw => { if (ws.readyState === WebSocket.OPEN) ws.send(raw); }, () => ws.close(1009, 'CDP payload too large'));
        if (!relays.has(targetId)) relays.set(targetId, new Set());
        relays.get(targetId).add(relay);
        ws.on('close', () => {
          clients.get(targetId)?.delete(ws);
          relays.get(targetId)?.delete(relay);
          if (!clients.get(targetId)?.size) { clients.delete(targetId); relays.delete(targetId); }
        });
        ws.on('message', data => relay.receive(String(data)));
      }
      ws.on('error', err => {
        log('ws.error', { path: url.pathname, targetId, message: err?.message ?? String(err) });
      });
    });
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    port: server.address().port,
    close: async () => {
      clearInterval(heartbeatTimer); heartbeatTimer = undefined;
      clearTimeout(graceTimer); graceTimer = undefined;
      clearPending('Bridge stopped');
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
    },
  };
}
