#!/usr/bin/env node
import { createConnection } from '@playwright/mcp';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { BackendController, previewInstructions } from './backend.mjs';

const excluded = new Set(['browser_close', 'browser_install', 'browser_file_upload', 'browser_drop', 'browser_run_code']);
const backendTool = {
  name: 'browser_backend',
  description: 'Choose shared Brave tabs or T3 built-in preview. With no arguments, report the selected backend, extension status, allowlist, and attached Brave targetIds. targetId is pinned per session in memory so parallel agents do not interfere. Preview selection requires T3 preview_* tools; this companion never proxies those tools.',
  inputSchema: { type: 'object', properties: { backend: { type: 'string', enum: ['brave', 'preview'] }, targetId: { type: 'string', description: 'Explicitly shared Brave targetId for this session, required when several tabs are attached.' } }, additionalProperties: false },
};
const openTabTool = {
  name: 'browser_open_tab',
  description: 'Open (or reuse) an allowlisted HTTP/HTTPS URL directly in the user\'s signed-in Brave profile, attach it, and pin its targetId for this session. Only hosts matching the user\'s allowlist in T3 Brave Bridge are permitted; OAuth redirects from an opened tab stay attached automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL on an allowlisted domain.' },
      reuse: { type: 'boolean', description: 'Reuse an already-open tab matching the exact URL (default true). False always opens a new background tab.' },
      active: { type: 'boolean', description: 'Bring the new tab to the foreground in Brave (default false: opens quietly in background).' },
    },
    required: ['url'],
    additionalProperties: false,
  },
};
const closeTabTool = {
  name: 'browser_close_tab',
  description: 'Close a Brave tab that was opened by an agent via browser_open_tab. Refuses to close user-opened personal tabs.',
  inputSchema: {
    type: 'object',
    properties: {
      targetId: { type: 'string', description: 'Target ID to close (defaults to this session\'s pinned targetId).' },
    },
    additionalProperties: false,
  },
};
const result = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

export async function createCompanion({ controller = new BackendController() } = {}) {
  const server = new Server({ name: 't3-brave-companion', version: '0.2.0' }, { capabilities: { tools: {} } });
  let inner;
  let innerChain = Promise.resolve();
  let tools;

  const serialize = fn => {
    const run = innerChain.then(fn, fn);
    innerChain = run.catch(() => {});
    return run;
  };
  const closeInnerUnlocked = async () => {
    const previous = inner; inner = undefined;
    // Dispose MCP listeners first, then disconnect CDP without closing the shared tab.
    await previous?.client.close().catch(() => {});
    await previous?.server.close().catch(() => {});
    await controller.disconnect();
  };
  const closeInner = () => serialize(closeInnerUnlocked);
  const makeInner = async key => {
    const upstream = await createConnection({ browser: { isolated: false }, webmcp: false }, () => controller.context(key));
    const client = new Client({ name: 't3-brave-companion', version: '0.2.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await upstream.connect(serverTransport);
    await client.connect(clientTransport);
    return { server: upstream, client, key };
  };
  const ensureInner = key => serialize(async () => {
    if (inner && inner.key === key && controller.browser?.isConnected()) return inner;
    await closeInnerUnlocked();
    inner = await makeInner(key);
    return inner;
  });

  // Listing tools must work even with preview selected and no bridge running.
  const getTools = async () => {
    if (tools) return tools;
    const temporary = await makeInner(undefined);
    try { tools = (await temporary.client.listTools()).tools.filter(tool => !excluded.has(tool.name)); }
    finally { await temporary.client.close(); await temporary.server.close(); }
    return tools;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [backendTool, openTabTool, closeTabTool, ...await getTools()] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const args = params.arguments ?? {};
      if (params.name === 'browser_backend') {
        if (args.backend === undefined && args.targetId === undefined) return result(await controller.status());
        await closeInner();
        return result(await controller.select(args.backend ?? 'brave', args.targetId));
      }
      if (params.name === 'browser_open_tab') {
        if ((await controller.selection()).backend !== 'brave') {
          await closeInner();
          throw new Error(previewInstructions);
        }
        await closeInner();
        return result(await controller.openTab({ url: args.url, reuse: args.reuse ?? true, active: Boolean(args.active) }));
      }
      if (params.name === 'browser_close_tab') {
        if ((await controller.selection()).backend !== 'brave') {
          await closeInner();
          throw new Error(previewInstructions);
        }
        await closeInner();
        return result(await controller.closeTab(args.targetId));
      }
      if (excluded.has(params.name) || !(await getTools()).some(tool => tool.name === params.name)) {
        throw new Error(`Tool ${params.name} is not supported by the shared-tab companion.`);
      }
      if ((await controller.selection()).backend !== 'brave') {
        await closeInner();
        throw new Error(previewInstructions);
      }
      if (params.name === 'browser_tabs' && !['list', 'select'].includes(args.action)) {
        throw new Error('Only listing/selecting shared tabs is supported here. Use browser_open_tab / browser_close_tab for allowlisted agent tabs.');
      }
      const { key } = await controller.connectionKey();
      const active = await ensureInner(key);
      return await active.client.callTool({ name: params.name, arguments: args });
    } catch (error) { return { ...result(error.message), isError: true }; }
  });
  return { server, controller, close: async () => { await closeInner(); await server.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const companion = await createCompanion();
  await companion.server.connect(new StdioServerTransport());
  const stop = async () => { await companion.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  process.stdin.on('end', stop);
}
