const statusPill = document.querySelector('#status-pill');
const statusText = document.querySelector('#status-text');
const banner = document.querySelector('#banner');
const handoffBtn = document.querySelector('#handoff-btn');
const handoffLabel = document.querySelector('#handoff-label');
const tabsHeading = document.querySelector('#tabs-heading');
const tabsList = document.querySelector('#tabs');
const emptyState = document.querySelector('#empty-state');
const disconnectBtn = document.querySelector('#disconnect');
const chipsEl = document.querySelector('#chips');
const addForm = document.querySelector('#add-form');
const domainInput = document.querySelector('#domain-input');
const settingsToggle = document.querySelector('#settings-toggle');
const settingsDrawer = document.querySelector('#settings-drawer');
const tokenInput = document.querySelector('#token');
const portInput = document.querySelector('#port');
const saveSettingsBtn = document.querySelector('#save-settings');

let currentAllowlist = [];
let activeTab = null;
let activeTabs = [];

function formatHost(raw = '') {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return raw;
  }
}

function formatTitle(raw = '') {
  return (raw || '(untitled)')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .trim();
}

function showBanner(message, kind = 'error') {
  if (!message) {
    banner.textContent = '';
    banner.className = 'banner';
    return;
  }
  banner.textContent = message;
  banner.className = `banner visible${kind === 'info' ? ' info' : ''}`;
}

function setSettingsOpen(open) {
  settingsDrawer.classList.toggle('open', open);
  settingsToggle.setAttribute('aria-expanded', String(open));
}

function renderHandoff(tabs = []) {
  activeTabs = tabs;
  const shareable = Boolean(activeTab?.id && /^https?:/.test(activeTab.url ?? ''));
  if (!shareable) {
    handoffBtn.disabled = true;
    handoffBtn.className = 'handoff-btn';
    handoffLabel.textContent = 'Open a webpage to hand off';
    return;
  }
  const host = formatHost(activeTab.url);
  const isShared = tabs.some(t => t.tabId === activeTab.id);
  handoffBtn.disabled = false;
  handoffBtn.className = isShared ? 'handoff-btn active' : 'handoff-btn';
  handoffLabel.textContent = isShared ? `Release · ${host}` : `Hand off · ${host}`;
}

function renderTabs(tabs = []) {
  tabsList.textContent = '';
  tabsHeading.textContent = tabs.length ? `Active tabs (${tabs.length})` : 'Active tabs';
  disconnectBtn.classList.toggle('hidden', tabs.length === 0);
  emptyState.hidden = tabs.length > 0;

  for (const tab of tabs) {
    const li = document.createElement('li');
    li.className = 'tab-item';

    const dot = document.createElement('span');
    dot.className = 'tab-dot';

    const meta = document.createElement('div');
    meta.className = 'tab-meta';
    meta.title = tab.url ? `${tab.url}\nClick to switch to this tab` : 'Click to switch to this tab';
    meta.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'focus', tabId: tab.tabId }).catch(() => {});
    });

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = formatTitle(tab.title);

    const url = document.createElement('div');
    url.className = 'tab-url';
    url.textContent = formatHost(tab.url || '');

    meta.append(title, url);

    const btn = document.createElement('button');
    btn.className = 'unshare-btn';
    btn.type = 'button';
    btn.title = 'Disconnect tab';
    btn.setAttribute('aria-label', `Disconnect ${formatTitle(tab.title)}`);
    btn.textContent = '×';
    btn.addEventListener('click', async () => {
      display(await chrome.runtime.sendMessage({ action: 'unshare', tabId: tab.tabId }).catch(e => ({ ok: false, error: e.message })));
    });

    li.append(dot, meta, btn);
    tabsList.append(li);
  }
}

function renderAllowlist(list = []) {
  currentAllowlist = [...list];
  chipsEl.textContent = '';
  for (const pattern of list) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const label = document.createElement('span');
    label.textContent = pattern;
    const rm = document.createElement('button');
    rm.className = 'chip-remove';
    rm.type = 'button';
    rm.title = `Remove ${pattern}`;
    rm.setAttribute('aria-label', `Remove ${pattern}`);
    rm.textContent = '×';
    rm.addEventListener('click', async () => {
      const next = currentAllowlist.filter(item => item !== pattern);
      display(await chrome.runtime.sendMessage({ action: 'saveConfig', allowlist: next }).catch(e => ({ ok: false, error: e.message })));
    });
    chip.append(label, rm);
    chipsEl.append(chip);
  }
}

function display(result) {
  if (!result?.ok) {
    const err = result?.error || 'Unknown error';
    showBanner(err, 'error');
    if (/pair|token|connect/i.test(err)) setSettingsOpen(true);
    return;
  }
  showBanner('');

  if (result.connected) {
    statusPill.className = 'pill connected';
    statusText.textContent = 'Ready';
  } else if (result.reconnecting) {
    statusPill.className = 'pill reconnecting';
    statusText.textContent = 'Reconnecting';
  } else {
    statusPill.className = 'pill';
    statusText.textContent = 'Offline';
  }

  renderHandoff(result.tabs ?? []);
  renderTabs(result.tabs ?? []);
  if (Array.isArray(result.allowlist)) renderAllowlist(result.allowlist);
}

handoffBtn.addEventListener('click', async () => {
  if (!activeTab?.id) return;
  handoffBtn.disabled = true;
  const isShared = activeTabs.some(t => t.tabId === activeTab.id);
  const res = await chrome.runtime
    .sendMessage(isShared ? { action: 'unshare', tabId: activeTab.id } : { action: 'share' })
    .catch(e => ({ ok: false, error: e.message }));
  display(res);
});

addForm.addEventListener('submit', async event => {
  event.preventDefault();
  const raw = domainInput.value.trim();
  if (!raw) return;
  const next = [...currentAllowlist, raw];
  domainInput.value = '';
  display(await chrome.runtime.sendMessage({ action: 'saveConfig', allowlist: next }).catch(e => ({ ok: false, error: e.message })));
});

disconnectBtn.addEventListener('click', async () => {
  display(await chrome.runtime.sendMessage({ action: 'disconnect' }).catch(e => ({ ok: false, error: e.message })));
});

settingsToggle.addEventListener('click', () => {
  setSettingsOpen(!settingsDrawer.classList.contains('open'));
});

saveSettingsBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  const port = Number(portInput.value) || 9334;
  const res = await chrome.runtime.sendMessage({ action: 'saveConfig', token, port }).catch(e => ({ ok: false, error: e.message }));
  display(res);
  if (res?.ok) {
    showBanner('Bridge settings saved.', 'info');
    if (token) setTimeout(() => setSettingsOpen(false), 600);
  }
});

async function init() {
  const [saved, [tab], status] = await Promise.all([
    chrome.storage.local.get(['token', 'port', 'allowlist']),
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.runtime.sendMessage({ action: 'status' }).catch(e => ({ ok: false, error: e.message })),
  ]);
  activeTab = tab ?? null;
  tokenInput.value = saved.token ?? '';
  portInput.value = saved.port ?? 9334;
  if (!saved.token) setSettingsOpen(true);
  display(status);
}

void init();
