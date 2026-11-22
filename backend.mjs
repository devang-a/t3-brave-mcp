import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

export const previewInstructions = 'Built-in preview is selected. Use T3 preview_status, preview_open and preview_* tools. This companion does not proxy T3 preview tools. To use a shared Brave tab, call browser_backend with backend="brave".';

export class BackendController {
  constructor({
    directory = process.env.T3_BRAVE_STATE_DIR ?? join(homedir(), '.t3', 'brave-bridge'),
    configPath = process.env.T3_BRAVE_CONFIG,
    connect = (...args) => chromium.connectOverCDP(...args),
    pageWaitTimeoutMs = 2000,
  } = {}) {
    this.directory = directory;
    this.configPath = configPath ?? join(directory, 'config.json');
    this.selectionPath = join(directory, 'selection.json');
    this.connect = connect;
    this.pageWaitTimeoutMs = pageWaitTimeoutMs;
    this.sessionTargetId = undefined;
  }

  async selection() {
    let selected;
    try { selected = JSON.parse(await readFile(this.selectionPath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { backend: 'preview', ...(this.sessionTargetId ? { targetId: this.sessionTargetId } : {}) };
      throw new Error('Cannot read browser selection; fix or remove selection.json.');
    }
    if (!['brave', 'preview'].includes(selected.backend) || (selected.targetId !== undefined && typeof selected.targetId !== 'string')) {
      throw new Error('Invalid browser selection.');
    }
    // targetId is pinned per-session in memory (never read from shared selection.json)
    // so parallel agents never clobber each other's active Brave tab.
    return { backend: selected.backend, ...(this.sessionTargetId ? { targetId: this.sessionTargetId } : {}) };
  }

  async select(backend, targetId) {
    if (!['brave', 'preview'].includes(backend)) throw new Error('backend must be brave or preview');
    if (targetId !== undefined && targetId !== null && typeof targetId !== 'string') throw new Error('targetId must be a string');
    if (targetId === null || targetId === '') this.sessionTargetId = undefined;
    else if (targetId !== undefined) this.sessionTargetId = targetId;

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.selectionPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ backend }) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.selectionPath);
    } finally { await rm(temporary, { force: true }); }
    await this.disconnect();
    return this.status();
  }

  async configuration() {
    let config;
    try { config = JSON.parse(await readFile(this.configPath, 'utf8')); }
    catch { throw new Error('Brave bridge is not configured. Start the bridge, then pair its extension.'); }
    let endpoint;
    try { endpoint = new URL(config.endpoint); } catch { throw new Error('Invalid Brave bridge endpoint.'); }
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || typeof config.token !== 'string' || config.token.length < 32) {
      throw new Error('Brave bridge must use an authenticated http://127.0.0.1 endpoint.');
    }
    return { endpoint: endpoint.origin, token: config.token };
  }

  async bridgeStatus() {
    const config = await this.configuration();
    let response;
    try {
      response = await fetch(`${config.endpoint}/status`, {
        headers: { Authorization: `Bearer ${config.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      throw new Error('Brave bridge is unavailable. Start the bridge, or switch browser_backend to preview.');
    }
    if (!response.ok) throw new Error(`Brave bridge returned HTTP ${response.status}; check its pairing configuration.`);
    const data = await response.json();
    if (!data || typeof data.connected !== 'boolean' || !Array.isArray(data.targets)) throw new Error('Invalid Brave bridge status.');
    return data;
  }

  async targets() {
    const config = await this.configuration();
    let response;
    try { response = await fetch(`${config.endpoint}/json/list`, { headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error', signal: AbortSignal.timeout(3000) }); }
    catch { throw new Error('Brave bridge is unavailable. Start the bridge, or switch browser_backend to preview.'); }
    if (!response.ok) throw new Error(`Brave bridge returned HTTP ${response.status}; check its pairing configuration.`);
    const list = await response.json();
    if (!Array.isArray(list)) throw new Error('Invalid Brave target list.');
    const targets = list.filter(target => target.type === 'page' && typeof target.id === 'string' && typeof target.webSocketDebuggerUrl === 'string');
    return { config, targets };
  }

  async openTab({ url, reuse = true, active = false }) {
    if (typeof url !== 'string' || !url.trim()) throw new Error('url must be a non-empty string');
    let parsed;
    try { parsed = new URL(url.trim()); } catch { throw new Error('Invalid URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http and https URLs can be opened.');

    const config = await this.configuration();
    let response;
    try {
      response = await fetch(`${config.endpoint}/tabs/open`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: parsed.href, reuse, active: Boolean(active) }),
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new Error('Brave bridge is unavailable. Start the bridge, or switch browser_backend to preview.');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Failed to open tab (HTTP ${response.status}).`);
    if (typeof payload.targetId !== 'string') throw new Error('Bridge did not return a targetId.');
    this.sessionTargetId = payload.targetId;
    await this.disconnect();
    return payload;
  }

  async closeTab(targetId) {
    const id = targetId ?? this.sessionTargetId;
    if (typeof id !== 'string' || !id.trim()) throw new Error('targetId is required');
    const config = await this.configuration();
    let response;
    try {
      response = await fetch(`${config.endpoint}/tabs/close`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ targetId: id.trim() }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error('Brave bridge is unavailable.');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Failed to close tab (HTTP ${response.status}).`);
    if (this.sessionTargetId === id.trim()) this.sessionTargetId = undefined;
    await this.disconnect();
    return payload;
  }

  async status() {
    const selection = await this.selection();
    try {
      const [{ targets }, bridge] = await Promise.all([
        this.targets(),
        this.bridgeStatus().catch(() => undefined),
      ]);
      const extensionConnected = bridge?.connected;
      let instructions;
      if (selection.backend === 'preview') instructions = previewInstructions;
      else if (extensionConnected === false) instructions = 'Brave extension is disconnected. Ensure Brave is open with T3 Brave Bridge enabled, or select preview.';
      else instructions = 'Use attachedTargets (choose targetId when multiple exist), or call browser_open_tab for allowlisted domains.';
      return {
        ...selection,
        ...(extensionConnected !== undefined ? { extensionConnected } : {}),
        ...(bridge?.allowlist ? { allowlist: bridge.allowlist } : {}),
        ...(bridge?.lastDisconnect ? { lastDisconnect: bridge.lastDisconnect } : {}),
        ...(bridge?.lastDetach ? { lastDetach: bridge.lastDetach } : {}),
        attachedTargets: targets.map(({ id, title, url, agentOpened }) => ({ targetId: id, title, url, ...(agentOpened ? { agentOpened: true } : {}) })),
        instructions,
      };
    } catch (error) {
      return {
        ...selection,
        attachedTargets: [],
        bridgeError: error.message,
        instructions: selection.backend === 'preview' ? previewInstructions : 'Pair and share a Brave tab, or select preview.',
      };
    }
  }

  async connectionKey() {
    const selection = await this.selection();
    if (selection.backend !== 'brave') throw new Error(previewInstructions);
    const { targets, config } = await this.targets();
    const target = selection.targetId ? targets.find(t => t.id === selection.targetId) : targets.length === 1 ? targets[0] : undefined;
    if (!target) {
      throw new Error(
        selection.targetId
          ? 'The selected Brave tab is no longer shared. Reattach it, open an allowlisted URL with browser_open_tab, or choose another targetId using browser_backend.'
          : targets.length
            ? 'Multiple Brave tabs are shared. Choose targetId with browser_backend before using browser tools.'
            : 'No Brave tab is shared. Call browser_open_tab for an allowlisted site, click Share this tab in Brave, or select preview.'
      );
    }
    const ws = new URL(target.webSocketDebuggerUrl);
    const endpoint = new URL(config.endpoint);
    if (ws.protocol !== 'ws:' || ws.hostname !== '127.0.0.1' || ws.port !== endpoint.port || ws.username || ws.password) {
      throw new Error('Bridge returned an invalid CDP endpoint.');
    }
    ws.search = ''; // Token travels as a header so errors cannot expose it in URLs.
    return { key: `${ws.href}|${config.token}`, endpoint: ws.href, token: config.token, targetId: target.id };
  }

  async context(expectedKey) {
    const info = await this.connectionKey();
    if (expectedKey && expectedKey !== info.key) throw new Error('Browser selection changed; retry the browser tool.');
    if (this.browser && this.key === info.key && this.browser.isConnected()) return this.browser.contexts()[0];
    await this.disconnect();
    this.browser = await this.connect(info.endpoint, { headers: { Authorization: `Bearer ${info.token}` }, timeout: 15000 });
    this.key = info.key;
    const deadline = Date.now() + this.pageWaitTimeoutMs;
    let context = this.browser.contexts()[0];
    while ((!context || context.pages().length !== 1) && Date.now() < deadline && this.browser?.isConnected()) {
      await new Promise(resolve => setTimeout(resolve, 50));
      context = this.browser?.contexts()[0];
    }
    if (!context || context.pages().length !== 1) {
      await this.disconnect();
      throw new Error('Expected one explicitly shared Brave page.');
    }
    return context;
  }

  async disconnect() {
    const browser = this.browser;
    this.browser = undefined; this.key = undefined;
    // For connectOverCDP, close disconnects this client; it does not close Brave.
    await browser?.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new BackendController();
  const action = process.argv[2] ?? 'status';
  try {
    if (!['brave', 'preview', 'status'].includes(action)) throw new Error('Usage: node backend.mjs brave|preview|status');
    console.log(JSON.stringify(action === 'status' ? await controller.status() : await controller.select(action, process.argv[3]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
