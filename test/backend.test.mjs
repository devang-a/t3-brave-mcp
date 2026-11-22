import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BackendController } from '../backend.mjs';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 't3-backend-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('backend defaults to preview, pins targetId per-session in memory, and persists only backend to selection.json', async t => {
  const path = await directory(t);
  const controllerA = new BackendController({ directory: path });
  const controllerB = new BackendController({ directory: path });
  assert.deepEqual(await controllerA.selection(), { backend: 'preview' });

  await controllerA.select('brave', 'tab-a');
  await controllerB.select('brave', 'tab-b');

  // Parallel agents keep independent targetId pins without clobbering each other.
  assert.deepEqual(await controllerA.selection(), { backend: 'brave', targetId: 'tab-a' });
  assert.deepEqual(await controllerB.selection(), { backend: 'brave', targetId: 'tab-b' });

  // selection.json stores only backend, never a shared targetId.
  assert.deepEqual(JSON.parse(await readFile(join(path, 'selection.json'), 'utf8')), { backend: 'brave' });

  // Switching backend preserves this session's in-memory targetId.
  await controllerA.select('preview');
  await controllerA.select('brave');
  assert.deepEqual(await controllerA.selection(), { backend: 'brave', targetId: 'tab-a' });
});

test('selection refuses unsupported backend and unsafe bridge endpoints', async t => {
  const path = await directory(t), controller = new BackendController({ directory: path });
  await assert.rejects(controller.select('other'), /brave or preview/);
  await writeFile(join(path, 'config.json'), JSON.stringify({ endpoint: 'https://example.com', token: 'a'.repeat(64) }));
  await assert.rejects(controller.configuration(), /127.0.0.1/);
});

test('MCP stdio lists tools without a bridge and honors preview mode', async t => {
  const path = await directory(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('mcp.mjs')], env: { ...process.env, T3_BRAVE_STATE_DIR: path }, stderr: 'pipe' });
  let errors = ''; transport.stderr?.on('data', chunk => { errors += chunk; });
  const client = new Client({ name: 'companion-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some(t => t.name === 'browser_backend'));
  assert.ok(tools.some(t => t.name === 'browser_open_tab'));
  assert.ok(tools.some(t => t.name === 'browser_close_tab'));
  assert.ok(tools.some(t => t.name === 'browser_snapshot'));
  assert.ok(!tools.some(t => t.name === 'browser_close'));
  const status = await client.callTool({ name: 'browser_backend', arguments: {} });
  assert.equal(JSON.parse(status.content[0].text).backend, 'preview');
  const blocked = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  assert.equal(blocked.isError, true); assert.match(blocked.content[0].text, /preview_\*/);
  const selected = await client.callTool({ name: 'browser_backend', arguments: { backend: 'brave', targetId: 'chosen' } });
  assert.equal(JSON.parse(selected.content[0].text).backend, 'brave');
  const unavailable = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  assert.equal(unavailable.isError, true); assert.match(unavailable.content[0].text, /not configured/);
  assert.equal(errors, '');
});
