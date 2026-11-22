import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createBridge } from '../bridge.mjs';

const token = 'a'.repeat(64);
const EXT_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const tick = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t, options = {}) {
  const bridge = await createBridge({ token, port: 0, heartbeatInterval: 0, log: () => {}, ...options });
  t.after(() => bridge.close());
  const base = `http://127.0.0.1:${bridge.port}`;
  const connect = async (path, wsOptions) => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}${path}`, wsOptions);
    await once(ws, 'open'); return ws;
  };
  return { bridge, base, connect };
}

function inbox(socket) {
  const queue = [], waiters = [];
  socket.on('message', data => { const message = JSON.parse(String(data)); const waiter = waiters.shift(); if (waiter) waiter(message); else queue.push(message); });
  return () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve));
}

async function attached(t, options) {
  const env = await setup(t, options);
  const extension = await env.connect(`/extension?token=${token}`, { origin: EXT_ORIGIN });
  const nextExtension = inbox(extension);
  extension.send(JSON.stringify({ method: 'bridge.targets', params: { targets: [{ targetId: 'selected-target', tabId: 1, type: 'page', title: 'Selected', url: 'https://example.com/' }] } }));
  await tick();
  const response = await fetch(`${env.base}/json/list`, { headers: { Authorization: `Bearer ${token}` } });
  const list = await response.json();
  const page = new WebSocket(list[0].webSocketDebuggerUrl);
  const nextPage = inbox(page);
  await once(page, 'open');
  return { ...env, extension, nextExtension, page, nextPage };
}

test('HTTP API requires token and exposes no unattached targets', async t => {
  const { base } = await setup(t);
  assert.equal((await fetch(`${base}/status`)).status, 401);
  assert.deepEqual(await (await fetch(`${base}/json/list?token=${token}`)).json(), []);
  assert.deepEqual(await (await fetch(`${base}/status?token=${token}`)).json(), { connected: false, targets: [] });
});

test('bridge denies webpage origins and missing origin on /extension even with valid token', async t => {
  const { base } = await setup(t);
  for (const wsOpts of [{ origin: 'https://evil.example' }, {}]) {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/extension?token=${token}`, wsOpts);
    const [error] = await once(ws, 'error');
    assert.match(error.message, /401/);
  }
});

test('unauthenticated /extension cannot replace the live extension socket', async t => {
  const { extension, base } = await attached(t);
  const intruder = new WebSocket(`${base.replace('http:', 'ws:')}/extension?token=${'b'.repeat(64)}`, { origin: EXT_ORIGIN });
  const [error] = await once(intruder, 'error');
  assert.match(error.message, /401/);
  assert.equal(extension.readyState, WebSocket.OPEN);
});

test('authenticated newer /extension replaces old socket cleanly without 409', async t => {
  const { extension, connect, base } = await attached(t);
  const oldClosed = once(extension, 'close');
  const replacement = await connect(`/extension?token=${token}`, { origin: EXT_ORIGIN });
  const [code] = await oldClosed;
  assert.equal(code, 1000);
  assert.equal(replacement.readyState, WebSocket.OPEN);
  const status = await (await fetch(`${base}/status?token=${token}`)).json();
  assert.equal(status.connected, true);
  assert.equal(status.targets.length, 1);
  replacement.close();
});

test('bridge replies to bridge.ping with bridge.pong', async t => {
  const { extension, nextExtension } = await attached(t);
  extension.send(JSON.stringify({ method: 'bridge.ping' }));
  assert.deepEqual(await nextExtension(), { method: 'bridge.pong' });
});

test('browser facade announces only selected target and routes CDP commands/events', async t => {
  const { extension, nextExtension, page, nextPage } = await attached(t);
  page.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
  assert.equal((await nextPage()).result.protocolVersion, '1.3');
  page.send(JSON.stringify({ id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
  assert.equal((await nextPage()).id, 2);
  const announcement = await nextPage();
  assert.equal(announcement.params.targetInfo.targetId, 'selected-target');
  const sessionId = announcement.params.sessionId;
  page.send(JSON.stringify({ id: 3, sessionId, method: 'Page.enable' }));
  const command = await nextExtension();
  assert.deepEqual(command.params, { targetId: 'selected-target', method: 'Page.enable', params: {} });
  extension.send(JSON.stringify({ id: command.id, result: {} }));
  assert.deepEqual(await nextPage(), { id: 3, result: {}, sessionId });
  extension.send(JSON.stringify({ method: 'bridge.event', params: { targetId: 'selected-target', method: 'Page.loadEventFired', params: { timestamp: 1 } } }));
  assert.deepEqual(await nextPage(), { method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId });
});

test('extension disconnect closes active client with 1011 while preserving targets during reconnectGrace', async t => {
  const { extension, page, base, connect } = await attached(t, { reconnectGrace: 120 });
  const closed = once(page, 'close');
  extension.close();
  const [code] = await closed;
  assert.equal(code, 1011);
  // During grace window, targets remain listed while connected is false.
  const during = await (await fetch(`${base}/status?token=${token}`)).json();
  assert.equal(during.connected, false);
  assert.equal(during.targets.length, 1);
  assert.ok(during.lastDisconnect);
  // After grace expires without reconnect, targets clear.
  await tick(180);
  const after = await (await fetch(`${base}/status?token=${token}`)).json();
  assert.equal(after.targets.length, 0);
  // Verify reconnecting inside grace cancels expiration.
  const ext2 = await connect(`/extension?token=${token}`, { origin: EXT_ORIGIN });
  ext2.send(JSON.stringify({ method: 'bridge.targets', params: { targets: [{ targetId: 't2', tabId: 2, type: 'page', title: 'T2', url: 'https://example.com/2' }] } }));
  await tick();
  ext2.close();
  await tick(30);
  const ext3 = await connect(`/extension?token=${token}`, { origin: EXT_ORIGIN });
  await tick(150);
  const recovered = await (await fetch(`${base}/status?token=${token}`)).json();
  assert.equal(recovered.connected, true);
  assert.equal(recovered.targets.length, 1);
  ext3.close();
});

test('lost commands return an error within the timeout', async t => {
  const { page, nextPage } = await attached(t, { commandTimeout: 20 });
  page.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach' }));
  await nextPage(); const announcement = await nextPage();
  page.send(JSON.stringify({ id: 2, sessionId: announcement.params.sessionId, method: 'Page.enable' }));
  assert.match((await nextPage()).error.message, /timed out/);
});

test('detaching a shared tab closes its CDP client', async t => {
  const { extension, page, base } = await attached(t);
  const closed = once(page, 'close');
  extension.send(JSON.stringify({ method: 'bridge.targets', params: { targets: [] } }));
  assert.equal((await closed)[0], 1000);
  assert.deepEqual(await (await fetch(`${base}/json/list?token=${token}`)).json(), []);
});

test('bridge.targetReset closes only that target relays with 1009 without killing extension or other tabs', async t => {
  const { extension, page, base } = await attached(t);
  extension.send(JSON.stringify({
    method: 'bridge.targets',
    params: {
      targets: [
        { targetId: 'selected-target', tabId: 1, type: 'page', title: 'One', url: 'https://example.com/1' },
        { targetId: 'other-target', tabId: 2, type: 'page', title: 'Two', url: 'https://example.com/2' },
      ],
    },
  }));
  await tick();
  const otherPage = new WebSocket(`${base.replace('http:', 'ws:')}/devtools/page/other-target?token=${token}`);
  await once(otherPage, 'open');
  const firstClosed = once(page, 'close');
  extension.send(JSON.stringify({ method: 'bridge.targetReset', params: { targetId: 'selected-target', reason: 'CDP event payload too large' } }));
  const [code] = await firstClosed;
  assert.equal(code, 1009);
  assert.equal(extension.readyState, WebSocket.OPEN);
  assert.equal(otherPage.readyState, WebSocket.OPEN);
  otherPage.close();
});

test('two clients share a target, second Runtime.enable replays cached contexts without Runtime.disable', async t => {
  const { extension, nextExtension, page, nextPage, base } = await attached(t);
  page.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach' }));
  await nextPage(); const firstAttach = await nextPage();
  const s1 = firstAttach.params.sessionId;

  // First client calls Runtime.enable -> sole client does disable + enable, caches context.
  page.send(JSON.stringify({ id: 2, sessionId: s1, method: 'Runtime.enable' }));
  const cmd1 = await nextExtension();
  assert.equal(cmd1.params.method, 'Runtime.disable');
  extension.send(JSON.stringify({ id: cmd1.id, result: {} }));
  const cmd2 = await nextExtension();
  assert.equal(cmd2.params.method, 'Runtime.enable');
  extension.send(JSON.stringify({ method: 'bridge.event', params: { targetId: 'selected-target', method: 'Runtime.executionContextCreated', params: { context: { id: 1, name: 'main' } } } }));
  extension.send(JSON.stringify({ id: cmd2.id, result: {} }));
  const m1 = await nextPage();
  const m2 = await nextPage();
  assert.ok([m1, m2].some(m => m.id === 2));
  assert.ok([m1, m2].some(m => m.method === 'Runtime.executionContextCreated' && m.params.context.id === 1));

  // Second client joins and calls Runtime.enable -> should NOT trigger Runtime.disable on extension!
  const second = new WebSocket(`${base.replace('http:', 'ws:')}/devtools/page/selected-target?token=${token}`);
  const nextSecond = inbox(second);
  await once(second, 'open');
  second.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach' }));
  await nextSecond(); const secondAttach = await nextSecond();
  const s2 = secondAttach.params.sessionId;

  let unexpectedCommand = false;
  const checkCmd = nextExtension().then(() => { unexpectedCommand = true; });
  second.send(JSON.stringify({ id: 2, sessionId: s2, method: 'Runtime.enable' }));
  const r1 = await nextSecond();
  const r2 = await nextSecond();
  assert.ok([r1, r2].some(m => m.id === 2));
  assert.ok([r1, r2].some(m => m.method === 'Runtime.executionContextCreated' && m.params.context.id === 1));
  await tick(30);
  assert.equal(unexpectedCommand, false);
  second.close();
  void checkCmd;
});

test('two clients share a target, both receive page events, and closing one preserves the other', async t => {
  const { extension, page, nextPage, base } = await attached(t);
  const second = new WebSocket(`${base.replace('http:', 'ws:')}/devtools/page/selected-target?token=${token}`);
  const nextSecond = inbox(second);
  await once(second, 'open');
  for (const socket of [page, second]) socket.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach' }));
  await nextPage(); const firstAttach = await nextPage();
  await nextSecond(); const secondAttach = await nextSecond();
  extension.send(JSON.stringify({ method: 'bridge.event', params: { targetId: 'selected-target', method: 'Page.loadEventFired', params: { timestamp: 7 } } }));
  assert.deepEqual(await nextPage(), { method: 'Page.loadEventFired', params: { timestamp: 7 }, sessionId: firstAttach.params.sessionId });
  assert.deepEqual(await nextSecond(), { method: 'Page.loadEventFired', params: { timestamp: 7 }, sessionId: secondAttach.params.sessionId });
  const closed = once(page, 'close'); page.close(); await closed;
  second.send(JSON.stringify({ id: 2, method: 'Browser.getVersion' }));
  assert.equal((await nextSecond()).result.protocolVersion, '1.3');
  const secondClosed = once(second, 'close'); extension.send(JSON.stringify({ method: 'bridge.targets', params: { targets: [] } }));
  assert.equal((await secondClosed)[0], 1000);
});

test('POST /tabs/open and /tabs/close enforce auth/origin and forward to extension', async t => {
  const { extension, nextExtension, base } = await attached(t);
  // Reject webpage origin even with valid token.
  const evil = await fetch(`${base}/tabs/open`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://app.example.com/' }),
  });
  assert.equal(evil.status, 401);

  // Publish allowlist from extension and verify /status surfaces it.
  extension.send(JSON.stringify({ method: 'bridge.config', params: { allowlist: ['*.example.com'] } }));
  await tick();
  const st = await (await fetch(`${base}/status`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(st.allowlist, ['*.example.com']);

  // Forward openTab and return result.
  const openPromise = fetch(`${base}/tabs/open`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://app.example.com/', reuse: true, active: false }),
  });
  const openCmd = await nextExtension();
  assert.equal(openCmd.method, 'bridge.openTab');
  assert.equal(openCmd.params.url, 'https://app.example.com/');
  extension.send(JSON.stringify({ id: openCmd.id, result: { targetId: 'auto-1', tabId: 42, url: openCmd.params.url, reused: false, agentOpened: true } }));
  const openRes = await openPromise;
  assert.equal(openRes.status, 200);
  assert.equal((await openRes.json()).targetId, 'auto-1');

  // Forward closeTab and propagate extension refusal as 403.
  const closePromise = fetch(`${base}/tabs/close`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetId: 'selected-target' }),
  });
  const closeCmd = await nextExtension();
  assert.equal(closeCmd.method, 'bridge.closeTab');
  extension.send(JSON.stringify({ id: closeCmd.id, error: { message: 'Refusing to close a user-opened tab; only agent-opened tabs can be closed automatically.' } }));
  const closeRes = await closePromise;
  assert.equal(closeRes.status, 403);
});
