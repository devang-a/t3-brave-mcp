const MAX_SEND_BYTES = 60 * 1024 * 1024;
const KEEP_ALIVE_MS = 20000;
const MAX_MISSED_PONGS = 3;
const RECONNECT_ALARM = 't3-brave-bridge-health';
const STORAGE_KEY = 'sharedTabs';
const DEFAULT_ALLOWLIST = [];
const encoder = new TextEncoder();

let socket;
let keepalive;
let reconnectTimer;
let reconnectAttempt = 0;
let connectingPromise;
let missedPongs = 0;
let lastDetach = null;
const attached = new Map(); // Explicitly shared or allowlist-opened tabs (tabId -> targetInfo).
const refreshTimers = new Map();

const normalizeAllowlist = raw => {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[\n,]/)
      : DEFAULT_ALLOWLIST;
  const cleaned = [];
  const seen = new Set();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const entry = item.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    cleaned.push(entry);
  }
  return cleaned;
};

const getConfig = async () => {
  const saved = await chrome.storage.local.get(['token', 'port', 'allowlist']);
  return {
    token: typeof saved.token === 'string' ? saved.token.trim() : '',
    port: Number.isInteger(saved.port) ? saved.port : Number(saved.port) || 9334,
    allowlist: saved.allowlist === undefined ? [...DEFAULT_ALLOWLIST] : normalizeAllowlist(saved.allowlist),
  };
};

const isUrlAllowed = (rawUrl, allowlist) => {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return { ok: false, reason: 'Invalid URL' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https URLs are permitted' };
  }
  const host = parsed.hostname.toLowerCase();
  for (const pattern of allowlist) {
    if (pattern === '*') return { ok: true, host };
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2);
      if (base && (host === base || host.endsWith(`.${base}`))) return { ok: true, host };
    } else if (host === pattern || host === `www.${pattern}`) {
      return { ok: true, host };
    }
  }
  return {
    ok: false,
    host,
    reason: `Host "${host}" is not in the T3 Brave Bridge allowlist. Add it in extension Settings or share the tab manually.`,
  };
};

const persistSharedTabs = async () => {
  try {
    const entries = [...attached.entries()].map(([tabId, info]) => [
      String(tabId),
      { tabId, targetId: info.targetId, title: info.title, url: info.url, agentOpened: Boolean(info.agentOpened) },
    ]);
    await chrome.storage.session.set({ [STORAGE_KEY]: Object.fromEntries(entries) });
  } catch { /* storage.session unavailable in older contexts */ }
};

const updateBadge = async () => {
  try {
    const count = attached.size;
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    if (count > 0) {
      const color = socket?.readyState === WebSocket.OPEN ? '#10b981' : '#f59e0b';
      await chrome.action.setBadgeBackgroundColor({ color });
    }
  } catch {}
};

const syncAlarm = async () => {
  await updateBadge();
  try {
    const { token } = await getConfig();
    if (token || attached.size > 0) {
      const existing = await chrome.alarms.get(RECONNECT_ALARM);
      if (!existing) chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
    } else {
      await chrome.alarms.clear(RECONNECT_ALARM);
    }
  } catch {}
};

const safeSend = value => {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  const raw = JSON.stringify(value);
  if (encoder.encode(raw).length > MAX_SEND_BYTES) {
    if (value.id !== undefined) {
      socket.send(JSON.stringify({ id: value.id, error: { message: 'CDP response payload too large' } }));
    } else if (value.method === 'bridge.event' && value.params?.targetId) {
      socket.send(JSON.stringify({ method: 'bridge.targetReset', params: { targetId: value.params.targetId, reason: 'CDP event payload too large' } }));
    }
    return false;
  }
  socket.send(raw);
  return true;
};

const publish = async () => {
  const { allowlist } = await getConfig().catch(() => ({ allowlist: DEFAULT_ALLOWLIST }));
  safeSend({ method: 'bridge.targets', params: { targets: [...attached.values()], allowlist } });
};

const closeSocketOnly = () => {
  clearInterval(keepalive); keepalive = undefined;
  missedPongs = 0;
  const old = socket; socket = undefined;
  try { old?.close(); } catch {}
};

const cancelReconnect = () => {
  clearTimeout(reconnectTimer); reconnectTimer = undefined;
  reconnectAttempt = 0;
};

const scheduleReconnect = async () => {
  if (reconnectTimer || socket?.readyState === WebSocket.OPEN) return;
  const { token } = await getConfig().catch(() => ({ token: '' }));
  if (!token && attached.size === 0) return;
  const delay = Math.min(1000 * (2 ** reconnectAttempt), 15000);
  reconnectAttempt = Math.min(reconnectAttempt + 1, 5);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect().catch(() => { void scheduleReconnect(); });
  }, delay);
};

// Explicit user-initiated disconnect: detaches all shared tabs and clears session state.
// Keeps the bridge link available if paired so future allowlisted auto-opens still work.
const disconnectAll = async () => {
  for (const timer of refreshTimers.values()) clearTimeout(timer);
  refreshTimers.clear();
  const tabs = [...attached.keys()];
  attached.clear();
  await persistSharedTabs();
  await Promise.allSettled(tabs.map(tabId => chrome.debugger.detach({ tabId })));
  await publish();
  await syncAlarm();
};

const unshareTab = async tabId => {
  const timer = refreshTimers.get(tabId);
  if (timer) { clearTimeout(timer); refreshTimers.delete(tabId); }
  attached.delete(tabId);
  await persistSharedTabs();
  await chrome.debugger.detach({ tabId }).catch(() => {});
  await publish();
  await syncAlarm();
};

// Adopt-only rehydration: never calls chrome.debugger.attach().
// Only probes tabIds previously shared by this extension in chrome.storage.session.
const rehydrateAdoptedTabs = async () => {
  let stored;
  try {
    const data = await chrome.storage.session.get(STORAGE_KEY);
    stored = data?.[STORAGE_KEY];
  } catch { return; }
  if (!stored || typeof stored !== 'object') return;
  let changed = false;
  for (const entry of Object.values(stored)) {
    const tabId = Number(entry?.tabId);
    if (!Number.isInteger(tabId) || attached.has(tabId)) continue;
    try {
      const { targetInfo } = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
      if (targetInfo && typeof targetInfo.targetId === 'string') {
        attached.set(tabId, {
          ...targetInfo,
          tabId,
          userAgent: navigator.userAgent,
          agentOpened: Boolean(entry.agentOpened),
        });
        changed = true;
      }
    } catch {
      changed = true;
    }
  }
  if (changed) {
    await persistSharedTabs();
    await syncAlarm();
    if (socket?.readyState === WebSocket.OPEN) await publish();
  }
};

const attachExistingTab = async (tabId, { agentOpened = false } = {}) => {
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    try {
      const { targetInfo } = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
      attached.set(tabId, { ...targetInfo, tabId, userAgent: navigator.userAgent, agentOpened });
    } catch (error) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      throw error;
    }
  }
  await persistSharedTabs();
  await syncAlarm();
  await publish();
  return attached.get(tabId);
};

const handleOpenTab = async ({ url, reuse = true, active = false } = {}) => {
  const { allowlist } = await getConfig();
  const check = isUrlAllowed(url, allowlist);
  if (!check.ok) throw new Error(check.reason);

  const normalizedUrl = new URL(url).href;
  if (reuse) {
    // 1. Check already-attached tabs for exact URL match.
    for (const info of attached.values()) {
      if (info.url === normalizedUrl) {
        return { targetId: info.targetId, tabId: info.tabId, url: info.url, title: info.title || '', reused: true, agentOpened: Boolean(info.agentOpened) };
      }
    }
    // 2. Check open browser tabs for an exact URL match (attach without marking agentOpened so we don't close user's tab).
    const existingTabs = await chrome.tabs.query({});
    const exactMatch = existingTabs.find(t => t.id && t.url === normalizedUrl);
    if (exactMatch?.id) {
      const info = await attachExistingTab(exactMatch.id, { agentOpened: false });
      return { targetId: info.targetId, tabId: info.tabId, url: info.url || normalizedUrl, title: info.title || exactMatch.title || '', reused: true, agentOpened: false };
    }
  }

  // 3. Open a fresh tab (background by default) on the allowlisted URL and attach immediately.
  const created = await chrome.tabs.create({ url: normalizedUrl, active: Boolean(active) });
  if (!created?.id) throw new Error('Failed to create Brave tab');
  const info = await attachExistingTab(created.id, { agentOpened: true });
  return { targetId: info.targetId, tabId: info.tabId, url: info.url || normalizedUrl, title: info.title || created.title || '', reused: false, agentOpened: true };
};

const handleCloseTab = async ({ targetId } = {}) => {
  const entry = [...attached.entries()].find(([, info]) => info.targetId === targetId);
  if (!entry) throw new Error('Tab is not shared');
  const [tabId, info] = entry;
  if (!info.agentOpened) {
    throw new Error('Refusing to close a user-opened tab; only agent-opened tabs can be closed automatically.');
  }
  const timer = refreshTimers.get(tabId);
  if (timer) { clearTimeout(timer); refreshTimers.delete(tabId); }
  attached.delete(tabId);
  await persistSharedTabs();
  await chrome.debugger.detach({ tabId }).catch(() => {});
  await chrome.tabs.remove(tabId).catch(() => {});
  await publish();
  await syncAlarm();
  return { closed: true, targetId };
};

async function connect() {
  if (socket?.readyState === WebSocket.OPEN) return;
  if (connectingPromise) return connectingPromise;
  connectingPromise = (async () => {
    closeSocketOnly();
    const { token, port } = await getConfig();
    if (!token || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Pair the local bridge first');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension?token=${encodeURIComponent(token)}`);
    socket = ws;
    missedPongs = 0;

    ws.addEventListener('close', () => {
      if (socket === ws) {
        // Never detach shared debugger tabs on a transient WebSocket drop.
        closeSocketOnly();
        void updateBadge();
        void scheduleReconnect();
      }
    });

    ws.addEventListener('message', async event => {
      missedPongs = 0;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.method === 'bridge.ping') return safeSend({ method: 'bridge.pong' });
      if (message.method === 'bridge.pong') return;
      if (message.method === 'bridge.seedAllowlist') {
        const saved = await chrome.storage.local.get(['allowlist']);
        if (saved.allowlist === undefined && Array.isArray(message.params?.allowlist) && message.params.allowlist.length) {
          await chrome.storage.local.set({ allowlist: normalizeAllowlist(message.params.allowlist) });
          await publish();
        }
        return;
      }
      if (message.method === 'bridge.openTab') {
        try { safeSend({ id: message.id, result: await handleOpenTab(message.params) }); }
        catch (error) { safeSend({ id: message.id, error: { message: error.message } }); }
        return;
      }
      if (message.method === 'bridge.closeTab') {
        try { safeSend({ id: message.id, result: await handleCloseTab(message.params) }); }
        catch (error) { safeSend({ id: message.id, error: { message: error.message } }); }
        return;
      }
      if (message.method !== 'bridge.command') return;
      const { targetId, method, params, sessionId } = message.params ?? {};
      try {
        const entry = [...attached.entries()].find(([, info]) => info.targetId === targetId);
        if (!entry) throw new Error('Tab is not shared');
        const result = await chrome.debugger.sendCommand({ tabId: entry[0], ...(sessionId ? { sessionId } : {}) }, method, params);
        safeSend({ id: message.id, result: result ?? {} });
      } catch (error) { safeSend({ id: message.id, error: { message: error.message } }); }
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (socket === ws) closeSocketOnly();
        reject(new Error('Local bridge connection timed out'));
      }, 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        if (socket === ws) closeSocketOnly();
        reject(new Error('Cannot connect to the local bridge. Check token and start the bridge.'));
      }, { once: true });
    });

    cancelReconnect();
    await updateBadge();
    await syncAlarm();
    // Non-wall-clock missed-pong counter (immune to macOS sleep/wake clock jumps).
    keepalive = setInterval(() => {
      if (socket !== ws || ws.readyState !== WebSocket.OPEN) { clearInterval(keepalive); keepalive = undefined; return; }
      if (missedPongs >= MAX_MISSED_PONGS) {
        closeSocketOnly();
        void updateBadge();
        void scheduleReconnect();
        return;
      }
      missedPongs += 1;
      safeSend({ method: 'bridge.ping' });
    }, KEEP_ALIVE_MS);
    await publish();
  })().finally(() => { connectingPromise = undefined; });
  return connectingPromise;
}

const scheduleTargetRefresh = tabId => {
  if (!attached.has(tabId)) return;
  const existing = refreshTimers.get(tabId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    refreshTimers.delete(tabId);
    if (!attached.has(tabId)) return;
    try {
      const { targetInfo } = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
      if (targetInfo && attached.has(tabId)) {
        const prev = attached.get(tabId);
        attached.set(tabId, { ...prev, ...targetInfo, tabId, userAgent: navigator.userAgent, agentOpened: Boolean(prev.agentOpened) });
        await persistSharedTabs();
        await publish();
      }
    } catch {}
  }, 200);
  refreshTimers.set(tabId, timer);
};

chrome.debugger.onEvent.addListener((source, method, params) => {
  const info = attached.get(source.tabId);
  if (!info) return;
  if ((method === 'Page.frameNavigated' && !params?.frame?.parentId) || method === 'Page.navigatedWithinDocument' || method === 'Page.loadEventFired') {
    if (params?.frame?.url) info.url = params.frame.url;
    else if (params?.url) info.url = params.url;
    scheduleTargetRefresh(source.tabId);
  }
  safeSend({ method: 'bridge.event', params: { targetId: info.targetId, method, params, ...(source.sessionId ? { sessionId: source.sessionId } : {}) } });
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
  const info = attached.get(source.tabId);
  const timer = refreshTimers.get(source.tabId);
  if (timer) { clearTimeout(timer); refreshTimers.delete(source.tabId); }
  attached.delete(source.tabId);
  lastDetach = { tabId: source.tabId, targetId: info?.targetId, reason: reason || 'unknown', at: new Date().toISOString() };
  await persistSharedTabs();
  await syncAlarm();
  if (info?.targetId) safeSend({ method: 'bridge.detach', params: { targetId: info.targetId, reason: reason || 'unknown' } });
  await publish();
});

const ensureOnline = async () => {
  await rehydrateAdoptedTabs();
  const { token } = await getConfig();
  if (token && socket?.readyState !== WebSocket.OPEN) {
    connect().catch(() => { void scheduleReconnect(); });
  }
  await syncAlarm();
};

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== RECONNECT_ALARM) return;
  await ensureOnline();
});

chrome.runtime.onStartup.addListener(() => { void ensureOnline(); });
chrome.runtime.onInstalled.addListener(() => { void ensureOnline(); });
chrome.commands?.onCommand.addListener(async command => {
  if (command !== 'toggle-handoff') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url ?? '')) return;
    if (attached.has(tab.id)) {
      await unshareTab(tab.id);
    } else {
      await rehydrateAdoptedTabs();
      await connect();
      await attachExistingTab(tab.id, { agentOpened: false });
    }
  } catch {}
});
void ensureOnline();

const statusPayload = async () => {
  const { allowlist } = await getConfig();
  return {
    connected: socket?.readyState === WebSocket.OPEN,
    reconnecting: Boolean(reconnectTimer || connectingPromise),
    count: attached.size,
    allowlist,
    tabs: [...attached.values()].map(({ tabId, targetId, title, url, agentOpened }) => ({
      tabId, targetId, title, url, agentOpened: Boolean(agentOpened),
    })),
    lastDetach,
  };
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  (async () => {
    if (message.action === 'status') {
      await ensureOnline();
      return statusPayload();
    }
    if (message.action === 'saveConfig') {
      const updates = {};
      const reconnectNeeded = typeof message.token === 'string' || message.port !== undefined;
      if (typeof message.token === 'string') updates.token = message.token.trim();
      if (message.port !== undefined) updates.port = Number(message.port) || 9334;
      if (message.allowlist !== undefined) updates.allowlist = normalizeAllowlist(message.allowlist);
      await chrome.storage.local.set(updates);
      if (reconnectNeeded) {
        closeSocketOnly();
        if (updates.token || (await getConfig()).token) {
          await connect().catch(() => { void scheduleReconnect(); });
        }
      }
      await publish();
      await syncAlarm();
      return statusPayload();
    }
    if (message.action === 'disconnect') {
      await disconnectAll();
      return statusPayload();
    }
    if (message.action === 'unshare') {
      const tabId = Number(message.tabId);
      if (!Number.isInteger(tabId)) throw new Error('Invalid tabId');
      await unshareTab(tabId);
      return statusPayload();
    }
    if (message.action === 'focus') {
      const tabId = Number(message.tabId);
      if (!Number.isInteger(tabId)) throw new Error('Invalid tabId');
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      return statusPayload();
    }
    if (message.action !== 'share') throw new Error('Unknown action');
    if (message.token) await chrome.storage.local.set({ token: message.token.trim(), port: Number(message.port ?? 9334) });
    await rehydrateAdoptedTabs();
    await connect();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url ?? '')) throw new Error('Select a regular HTTP or HTTPS page to share');
    await attachExistingTab(tab.id, { agentOpened: false });
    return statusPayload();
  })().then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message }));
  return true;
});
