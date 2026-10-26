// Service worker: routes requests from Claude (via the MCP bridge) and from the side panel
// to the Chrome driver and the Jev agent.
import { loadSettings, saveSettings, isBlocked, describe, relayEndpoint, DEFAULTS } from './lib/settings.js';
import { IRREVERSIBLE } from './lib/policy.js';
import { makeProvider, endpoints } from './lib/provider.js';
import { runTask, findElement, checkPage } from './lib/agent.js';
import { runChat } from './lib/chat.js';
import { ChromeDriver, releaseDebugger } from './lib/driver.js';
import { Bridge } from './lib/bridge.js';

const VERSION = chrome.runtime.getManifest().version;
const ports = new Set(); // every open extension page (side panels and the settings page) for status updates
const panels = new Set(); // open side panels only: the pages that can answer a confirmation
const tasks = new Map(); // taskId -> { abort, tabId, source, goal }
const confirms = new Map(); // confirmId -> resolve
let bridge; // local MCP server (Claude Code, Codex, Claude Desktop)
let relay; // jevbrowsercontrol.com relay for remote AI apps (Grok Bot, ChatGPT, claude.ai); off by default

// ---------- helpers ----------

function broadcast(msg) {
  for (const p of ports) { try { p.postMessage(msg); } catch {} }
}

// "Last tab" memory is per agent (per MCP session): the bridge stamps every
// request with a client id, so two agents pointing at "their" tab never
// navigate each other's page away. Requests without a client id (older
// servers, the side panel) keep the single legacy pointer.
async function rememberTab(tabId, client) {
  if (!client) return void chrome.storage.session.set({ claudeTab: tabId });
  const { agentTabs = {} } = await chrome.storage.session.get('agentTabs');
  agentTabs[client] = tabId;
  await chrome.storage.session.set({ agentTabs });
}

async function lastTabOf(client) {
  if (!client) return (await chrome.storage.session.get('claudeTab')).claudeTab;
  return (await chrome.storage.session.get('agentTabs')).agentTabs?.[client];
}

async function currentTabId(params = {}, client) {
  if (params.tabId) {
    await chrome.tabs.get(params.tabId).catch(() => { throw new Error(`No tab with id ${params.tabId}. Call browser_tabs to list tabs.`); });
    return params.tabId;
  }
  const ptr = await lastTabOf(client);
  if (ptr) {
    const tab = await chrome.tabs.get(ptr).catch(() => null);
    if (tab) return tab.id;
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active) return active.id;
  const [any] = await chrome.tabs.query({ active: true });
  if (!any) throw new Error('No open tab. Call browser_navigate with newTab: true.');
  return any.id;
}

async function groupTab(tabId, settings) {
  if (!settings.groupTabs || !chrome.tabGroups) return;
  try {
    let { jevGroup } = await chrome.storage.session.get('jevGroup');
    const tab = await chrome.tabs.get(tabId);
    const group = jevGroup ? await chrome.tabGroups.get(jevGroup).catch(() => null) : null;
    if (group && group.windowId === tab.windowId) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: group.id });
    } else {
      jevGroup = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
      await chrome.tabGroups.update(jevGroup, { title: 'Jev', color: 'orange' });
      await chrome.storage.session.set({ jevGroup });
    }
  } catch {}
}

async function driverFor(params, settings, client) {
  const tabId = await currentTabId(params, client);
  const tab = await chrome.tabs.get(tabId);
  if (isBlocked(settings, tab.url)) throw new Error(`${new URL(tab.url).hostname} is on the blocked list in Jev Browser Control settings.`);
  return new ChromeDriver(tabId, { inputMode: settings.inputMode, onTab: (id) => rememberTab(id, client) });
}

function checkUrl(url, settings) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`Not a valid URL: ${url}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https URLs can be opened.');
  if (isBlocked(settings, url)) throw new Error(`${u.hostname} is on the blocked list in Jev Browser Control settings.`);
  return u.href;
}

async function brief(driver) {
  const page = await driver.observe({ viewportOnly: true, max: 80, textChars: 1500, includeDisabled: true });
  return { tabId: driver.tabId, page };
}

async function setBadge(text) {
  await chrome.action.setBadgeBackgroundColor({ color: '#FA903E' }).catch(() => {});
  await chrome.action.setBadgeText({ text }).catch(() => {});
}

// Ask the person in the side panel. Resolves false at once when no side panel is open,
// and after a minute without an answer.
function askPanel({ label, url, taskId, source }) {
  if (!panels.size) return Promise.resolve(false);
  return new Promise((resolve) => {
    const cid = crypto.randomUUID();
    const timer = setTimeout(() => { confirms.delete(cid); broadcast({ type: 'confirm-expired', id: cid }); resolve(false); }, 60_000);
    confirms.set(cid, (ok) => { clearTimeout(timer); resolve(ok); });
    for (const p of panels) { try { p.postMessage({ type: 'confirm', id: cid, taskId, label, url, source }); } catch {} }
  });
}

// ---------- the Jev task runner (shared by Claude and the side panel) ----------

async function startTask({ goal, details, url, tabId, newTab, maxSteps, maxSeconds, allowIrreversible }, { emit = () => {}, source, client } = {}) {
  const settings = await loadSettings();
  if (!goal || !String(goal).trim()) throw new Error('Give Jev a goal.');
  let id = tabId;
  if (newTab) {
    if (!url) throw new Error('newTab needs a url.');
    const tab = await chrome.tabs.create({ url: checkUrl(url, settings), active: true });
    id = tab.id;
    await groupTab(id, settings);
  }
  const driver = await driverFor({ tabId: id }, settings, client);
  if (url && !newTab) {
    const current = (await chrome.tabs.get(driver.tabId)).url;
    if (current !== url) await driver.navigate(checkUrl(url, settings));
  }
  if (client) await rememberTab(driver.tabId, client);
  else if (source === 'claude') await rememberTab(driver.tabId);

  const taskId = crypto.randomUUID();
  const abort = new AbortController();
  tasks.set(taskId, { abort, tabId: driver.tabId, source, client, goal });
  const provider = makeProvider(settings);
  const onEvent = (event) => {
    const e = { ...event, taskId, source };
    broadcast({ type: 'event', event: e });
    emit(e);
    if (event.type === 'action') setBadge(String(event.step));
  };
  // Irreversible clicks: the side panel asks the person. Claude's local calls stop and report instead.
  // Remote apps can never skip the question: they get the side panel's answer, or a stop.
  const confirm = source === 'panel' || source === 'remote' ? ({ label, url: pageUrl }) => askPanel({ label, url: pageUrl, taskId, source }) : undefined;
  if (source === 'remote') allowIrreversible = false;
  await setBadge('…');
  try {
    return await runTask({
      goal, details, driver, provider, signal: abort.signal, onEvent, confirm, allowIrreversible: !!allowIrreversible,
      settings: { ...settings, maxSteps: maxSteps || settings.maxSteps, maxSeconds: maxSeconds || settings.maxSeconds },
    });
  } finally {
    tasks.delete(taskId);
    await setBadge('');
    broadcast({ type: 'idle', taskId });
    setTimeout(() => releaseDebugger(driver.tabId), 30_000);
  }
}

// ---------- request handlers (method names used by the MCP server) ----------

const handlers = {
  async status(_params, ctx = {}) {
    const settings = await loadSettings();
    const tabId = await currentTabId({}, ctx.client).catch(() => null);
    const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
    return { version: VERSION, extensionId: chrome.runtime.id, settings: describe(settings), current_tab: tab && { tabId: tab.id, url: tab.url, title: tab.title }, running_tasks: [...tasks.values()].map((t) => ({ goal: t.goal, tabId: t.tabId, source: t.source })) };
  },

  async 'tabs.list'(_params, ctx = {}) {
    const tabs = await chrome.tabs.query({});
    const ptr = await lastTabOf(ctx.client);
    return tabs.map((t) => ({ tabId: t.id, windowId: t.windowId, active: t.active, current: t.id === ptr, title: t.title, url: t.url }));
  },

  async 'tabs.select'({ tabId }, ctx = {}) {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    await rememberTab(tabId, ctx.client);
    return { tabId, url: tab.url, title: tab.title };
  },

  async 'tabs.close'({ tabId }) {
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  },

  async navigate(params, ctx = {}) {
    const settings = await loadSettings();
    const url = checkUrl(params.url, settings);
    if (params.newTab) {
      const tab = await chrome.tabs.create({ url, active: true });
      await rememberTab(tab.id, ctx.client);
      await groupTab(tab.id, settings);
      const driver = new ChromeDriver(tab.id, { inputMode: settings.inputMode });
      await driver.waitForLoad(15000);
      return brief(driver);
    }
    const driver = await driverFor(params, settings, ctx.client);
    await rememberTab(driver.tabId, ctx.client);
    await driver.navigate(url);
    return brief(driver);
  },

  async snapshot(params, ctx = {}) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings, ctx.client);
    await rememberTab(driver.tabId, ctx.client);
    const page = await driver.observe({ viewportOnly: !params.full, max: params.full ? 500 : 240, textChars: params.full ? 12000 : 6000, includeDisabled: true });
    return { tabId: driver.tabId, page };
  },

  async click(params, ctx = {}) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings, ctx.client);
    if (ctx.source === 'remote' && settings.confirmIrreversible !== false) {
      const p = await driver.run('prepare', { ref: Number(params.ref), kind: 'click' });
      if (p?.label && (IRREVERSIBLE.test(p.label) || p.publishes)) {
        const tab = await chrome.tabs.get(driver.tabId);
        const ok = await askPanel({ label: p.label, url: tab.url, source: 'remote' });
        if (!ok) throw new Error(`Clicking "${p.label}" needs the user's OK. Ask them to open the Jev side panel in Chrome and approve it, or to click it themselves.`);
      }
    }
    const r = await driver.click(Number(params.ref));
    await driver.settle({ kind: 'click', ref: Number(params.ref) });
    return { ...r, ...(await brief(driver)) };
  },

  async hover(params, ctx = {}) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings, ctx.client);
    const r = await driver.hover(Number(params.ref));
    await driver.wait(250);
    return { ...r, ...(await brief(driver)) };
  },

  async clipboard() {
    throw new Error('browser_clipboard works when the MCP server runs its own Chrome (browser mode), not through the extension.');
  },

  async record() {
    throw new Error('browser_record works when the MCP server runs its own Chrome (browser mode), not through the extension.');
  },

  async type(params, ctx = {}) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings, ctx.client);
    const r = await driver.fill(Number(params.ref), String(params.text ?? ''));
    await driver.settle({ kind: 'fill', ref: Number(params.ref) });
    if (params.submit) { await driver.pressKey('Enter', Number(params.ref)); await driver.settle({ kind: 'enter' }); }
    else await driver.wait(350); // many editors enable their Send/Comment button a moment after typing
    return { ...r, ...(await brief(driver)) };
  },

  async select(params, ctx = {}) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings, ctx.client);
    const r = await driver.select(Number(params.ref), { label: params.option, value: params.value });
    await driver.settle({ kind: 'select' });
    return { ...r, ...(await brief(driver)) };
  },

  async key(params, ctx = {}) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings, ctx.client);
    const r = await driver.pressKey(params.key, params.ref ? Number(params.ref) : undefined);
    await driver.settle({ kind: 'key' });
    return { ...r, ...(await brief(driver)) };
  },

  async scroll(params, ctx = {}) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings, ctx.client);
    await driver.scroll(params.direction || 'down', params.amount);
    return brief(driver);
  },

  async history(params, ctx = {}) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings, ctx.client);
    if (params.direction === 'forward') await driver.forward();
    else await driver.back();
    return brief(driver);
  },

  async wait(params, ctx = {}) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings, ctx.client);
    const until = Date.now() + Math.min(30, Number(params.seconds) || 5) * 1000;
    if (!params.text) { await new Promise((r) => setTimeout(r, until - Date.now())); return brief(driver); }
    while (Date.now() < until) {
      const r = await driver.read({ format: 'text', limit: 200000 }).catch(() => null);
      if (r?.content?.toLowerCase().includes(String(params.text).toLowerCase())) return { found: true, ...(await brief(driver)) };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { found: false, ...(await brief(driver)) };
  },

  async read(params, ctx = {}) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings, ctx.client);
    return driver.read({ format: params.format || 'markdown', offset: params.offset || 0, limit: Math.min(params.limit || 20000, 100000) });
  },

  async screenshot(params, ctx = {}) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings, ctx.client);
    return driver.screenshot({ quality: params.quality || 70 });
  },

  async 'jev.task'(params, ctx) {
    return startTask(params, ctx);
  },

  async 'jev.find'(params, ctx = {}) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings, ctx.client);
    return findElement({ description: params.description, driver, provider: makeProvider(settings), settings });
  },

  async 'jev.check'(params, ctx = {}) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings, ctx.client);
    return checkPage({ statement: params.statement, driver, provider: makeProvider(settings), settings });
  },

  async 'jev.stop'(_params, ctx = {}) {
    // Scoped: an agent stops only its own tasks. Without a client id (older
    // servers) the legacy behavior stays — stop everything.
    let stopped = 0;
    for (const t of tasks.values()) {
      if (ctx.client && t.client !== ctx.client) continue;
      t.abort.abort();
      stopped++;
    }
    return { stopped };
  },
};

async function onRequest(method, params, ctx) {
  const fn = handlers[method];
  if (!fn) throw new Error(`Unknown method ${method}. Update the Jev Browser Control extension.`);
  return fn(params, ctx);
}

// ---------- chat do painel lateral (LLM + ferramentas do navegador) ----------

const chatSessions = new Map(); // port -> { history: [], abort: AbortController | null }

async function chatExec(tool, args) {
  switch (tool) {
    case 'pagina_atual': return handlers.snapshot({}, {});
    case 'ler_pagina': return handlers.read({ format: 'text', limit: Math.min(Number(args.limite) || 8000, 20000) }, {});
    case 'navegar': return handlers.navigate({ url: String(args.url || ''), newTab: !!args.nova_aba }, {});
    case 'tarefa': {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return startTask({ goal: String(args.objetivo || ''), details: args.detalhes, tabId: tab?.id }, { source: 'panel' });
    }
    case 'verificar': return handlers['jev.check']({ statement: String(args.afirmacao || '') }, {});
    default: return { erro: `ferramenta desconhecida: ${tool}` };
  }
}

async function onChat(port, msg) {
  const sess = chatSessions.get(port) || { history: [], abort: null };
  chatSessions.set(port, sess);
  const settings = await loadSettings();
  if (!endpoints(settings).chatKey) {
    port.postMessage({ type: 'chat-error', message: 'Sem chave configurada. Abra Settings e cole a chave do OpenRouter.' });
    return;
  }
  if (msg.mode === 'computador') {
    port.postMessage({
      type: 'chat-done',
      fala: 'O modo Computador controla o PC inteiro (mouse, teclado, outros apps) e exige um aplicativo nativo companheiro, que ainda não faz parte do projeto. No modo Navegador eu já controlo as abas do seu Chrome com seus logins — troque o seletor pra Navegador e mande o comando.',
    });
    return;
  }
  sess.abort = new AbortController();
  port.postMessage({ type: 'chat-typing' });
  sess.history.push({ role: 'user', content: String(msg.text || '') });
  try {
    const { fala, cost } = await runChat({
      settings,
      history: sess.history.slice(-20),
      signal: sess.abort.signal,
      exec: chatExec,
      onEvent: (event) => { try { port.postMessage({ type: 'chat-event', event }); } catch {} },
    });
    sess.history.push({ role: 'assistant', content: fala });
    if (sess.history.length > 24) sess.history = sess.history.slice(-24);
    port.postMessage({ type: 'chat-done', fala, cost });
  } catch (err) {
    port.postMessage({ type: 'chat-error', message: String(err.message || err) });
  }
}

// ---------- side panel ----------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel' && port.name !== 'options') return;
  ports.add(port);
  if (port.name === 'panel') panels.add(port);
  port.onDisconnect.addListener(() => { ports.delete(port); panels.delete(port); });
  const sendState = async () => {
    const settings = await loadSettings();
    port.postMessage({ type: 'state', bridge: { connected: bridge?.connected, port: settings.bridgePort, enabled: settings.bridgeEnabled }, relay: { enabled: !!relayEndpoint(settings), connected: !!relay?.connected }, settings: describe(settings), running: [...tasks.entries()].map(([id, t]) => ({ taskId: id, goal: t.goal, source: t.source, tabId: t.tabId })) });
  };
  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'getState') return sendState();
    if (msg.type === 'stop') { for (const [id, t] of tasks) if (!msg.taskId || id === msg.taskId) t.abort.abort(); return; }
    if (msg.type === 'confirm') { confirms.get(msg.id)?.(!!msg.ok); confirms.delete(msg.id); return; }
    if (msg.type === 'run') {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        await startTask({ goal: msg.goal, details: msg.details, tabId: tab?.id }, { source: 'panel' });
      } catch (err) {
        port.postMessage({ type: 'error', message: String(err.message || err) });
      }
    }
    if (msg.type === 'chat') {
      try { await onChat(port, msg); } catch (err) { port.postMessage({ type: 'chat-error', message: String(err.message || err) }); }
      return;
    }
    if (msg.type === 'chat-stop') { chatSessions.get(port)?.abort?.abort(); return; }
    if (msg.type === 'reconnect') { bridge?.connect(); relay?.connect(); }
  });
  bridge?.connect();
  relay?.connect();
  sendState();
});

// ---------- startup ----------

async function init() {
  const settings = await loadSettings();
  bridge ||= new Bridge({
    port: settings.bridgePort,
    version: VERSION,
    onRequest,
    onStatus: (s) => broadcast({ type: 'bridge', ...s }),
  });
  bridge.setEnabled(settings.bridgeEnabled);
  relay ||= new Bridge({
    endpoint: relayEndpoint(settings),
    source: 'remote',
    version: VERSION,
    onRequest,
    onStatus: (s) => broadcast({ type: 'relay', connected: s.connected, enabled: !!relay?.endpoint }),
  });
  relay.setEndpoint(relayEndpoint(settings));
  relay.connect();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !bridge) return;
  if (changes.bridgePort) bridge.setPort(changes.bridgePort.newValue ?? DEFAULTS.bridgePort);
  if (changes.bridgeEnabled) bridge.setEnabled(changes.bridgeEnabled.newValue !== false);
  loadSettings().then((s) => {
    if (relay && (changes.remoteEnabled || changes.remoteKey || changes.cloudKey || changes.cloudBase)) {
      relay.setEndpoint(relayEndpoint(s));
      broadcast({ type: 'relay', connected: relay.connected, enabled: !!relay.endpoint });
    }
    broadcast({ type: 'settings', settings: describe(s) });
  });
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create('bridge', { periodInMinutes: 0.5 });
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('bridge', { periodInMinutes: 0.5 }));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'bridge') init().then(() => { bridge.connect(); relay.connect(); }); });

// Settings page "Test" button and first-run checks.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'testProvider') {
    (async () => {
      const settings = { ...(await loadSettings()), ...(msg.settings || {}) };
      const provider = makeProvider(settings);
      const t0 = Date.now();
      const r = await provider.decide({ model: settings.jevModel, state: { note: 'connection test' }, questions: { ok: { type: 'noul', instructions: 'Is `note` a connection test?' } } });
      return { ok: true, model: r.model, ms: Date.now() - t0, cost: provider.cost, balance: provider.balance };
    })().then(sendResponse, (err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg?.type === 'saveSettings') {
    saveSettings(msg.patch).then((s) => sendResponse({ ok: true, settings: describe(s) }));
    return true;
  }
  return false;
});

init();
