#!/usr/bin/env node
// CDP fallback: drive Chrome by the DevTools Protocol when the Jev extension is unavailable,
// stale or fighting with a page. No dependencies — Node 22 gives fetch and WebSocket.
//
//   node dom.mjs launch --port 9333 --dir C:\Users\supar\jbc-cdp [--from "Profile 2"] [--url https://...]
//   node dom.mjs targets --port 9333
//   node dom.mjs open  --port 9333 https://www.facebook.com/profile.php?id=61596283614464
//   node dom.mjs text   --port 9333 [chars]
//   node dom.mjs eval   --port 9333 "document.title"
//   node dom.mjs query  --port 9333 "a[href]" [limit]
//   node dom.mjs html   --port 9333 "#selector" [chars]
//   node dom.mjs click  --port 9333 "#selector"
//   node dom.mjs type   --port 9333 "#selector" "texto" [--submit]
//   node dom.mjs shot   --port 9333 saida.png
//
// Chrome 136+ ignores --remote-debugging-port when the profile is the default one, so `launch` always
// uses its own --user-data-dir. Point --from at a profile you copied while Chrome was closed when you
// need the site logins; otherwise it opens a clean profile.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const command = argv[0] || 'help';
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const positional = argv.slice(1).filter((a, i) => !a.startsWith('--') && !(argv.slice(1)[i - 1] || '').startsWith('--'));
const PORT = Number(flag('port', process.env.CDP_PORT || 9333));
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = flag('chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function version() {
  const res = await fetch(`${BASE}/json/version`).catch(() => null);
  if (!res?.ok) throw new Error(`No Chrome answering on port ${PORT}. Run: node dom.mjs launch --port ${PORT}`);
  return res.json();
}

async function newTarget(url = 'about:blank') {
  const res = await fetch(`${BASE}/json/new?${encodeURI(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`json/new returned ${res.status}`);
  return res.json();
}

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('Could not open the DevTools socket')), { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  const send = (method, params = {}, timeoutMs = 60_000) => new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => { pending.delete(mid); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(mid, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ws, send };
}

async function page(port) {
  const targets = await (await fetch(`${BASE}/json/list`)).json();
  const tab = targets.find((t) => t.type === 'page');
  if (!tab) throw new Error('No page target on this Chrome.');
  const { ws, send } = await attach(tab.webSocketDebuggerUrl);
  await send('Runtime.enable').catch(() => {});
  await send('Page.enable').catch(() => {});
  return { ws, send, tab };
}

async function evalValue(send, expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluation failed');
  return r.result?.value;
}

async function waitLoaded(send, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const state = await evalValue(send, 'document.readyState', false).catch(() => null);
    if (state === 'complete') return true;
    await sleep(200);
  }
  return false;
}

function elementSelectorExpression(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80), tag: el.tagName.toLowerCase() };
  })()`;
}

async function launch() {
  const dir = flag('dir', join(homedir(), 'jbc-cdp'));
  const from = flag('from');
  const url = flag('url', 'about:blank');
  mkdirSync(dir, { recursive: true });
  if (from) {
    const src = from.includes('\\') || from.includes('/') ? from : join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', from);
    if (!existsSync(src)) throw new Error(`Profile not found: ${src}`);
    const userData = dirname(src);
    const localState = join(userData, 'Local State');
    if (existsSync(localState)) copyFileSync(localState, join(dir, 'Local State'));
    const dst = join(dir, 'Profile 1');
    mkdirSync(dst, { recursive: true });
    const skip = new Set(['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Service Worker', 'Media Cache', 'CacheStorage', 'Extensions', 'File System', 'IndexedDB', 'Sessions']);
    for (const name of readdirSync(src)) {
      if (skip.has(name)) continue;
      const fromPath = join(src, name);
      const toPath = join(dst, name);
      const st = statSync(fromPath);
      if (st.isDirectory()) mkdirSync(toPath, { recursive: true });
      else copyFileSync(fromPath, toPath);
    }
    console.log(`profile copied from ${src} (Chrome must be closed for the cookie database to copy)`);
  }
  const child = spawn(CHROME, [
    `--user-data-dir=${dir}`,
    '--profile-directory=Profile 1',
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    url,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const v = await version().catch(() => null);
    if (v) { console.log(JSON.stringify({ ok: true, browser: v.Browser, port: PORT, userDataDir: dir }, null, 2)); return; }
  }
  throw new Error('Chrome did not open the debugging port. Close any Chrome using that data dir and retry.');
}

async function main() {
  switch (command) {
    case 'launch':
      return launch();
    case 'targets': {
      await version();
      const list = await (await fetch(`${BASE}/json/list`)).json();
      return console.log(list.map((t) => `${t.type}\t${t.title}\t${t.url}`).join('\n'));
    }
    case 'open': {
      const url = positional[0];
      if (!url) throw new Error('Usage: node dom.mjs open --port 9333 <url>');
      const tab = await newTarget(url);
      const { ws, send } = await attach(tab.webSocketDebuggerUrl);
      await waitLoaded(send);
      console.log(JSON.stringify({ ok: true, url: await evalValue(send, 'location.href', false), title: await evalValue(send, 'document.title', false) }));
      ws.close();
      return;
    }
    case 'text': {
      const { ws, send } = await page(PORT);
      const chars = Number(positional[0] || 4000);
      const out = await evalValue(send, `(document.body ? document.body.innerText : '').replace(/\\s+\\n/g, '\\n').slice(0, ${chars})`, false);
      console.log(out);
      ws.close();
      return;
    }
    case 'eval': {
      const expr = positional[0];
      if (!expr) throw new Error('Usage: node dom.mjs eval --port 9333 "<js>"');
      const { ws, send } = await page(PORT);
      const value = await evalValue(send, `(async () => (${expr}))()`);
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      ws.close();
      return;
    }
    case 'query': {
      const selector = positional[0];
      if (!selector) throw new Error('Usage: node dom.mjs query --port 9333 "<css selector>" [limit]');
      const limit = Math.min(Number(positional[1] || 50), 500);
      const { ws, send } = await page(PORT);
      const rows = await evalValue(send, `(() => {
        const out = [];
        for (const el of document.querySelectorAll(${JSON.stringify(selector)})) {
          if (out.length >= ${limit}) break;
          const r = el.getBoundingClientRect();
          out.push({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 160),
            href: el.getAttribute('href') || undefined,
            name: el.getAttribute('name') || undefined,
            value: 'value' in el ? String(el.value).slice(0, 120) : undefined,
            visible: r.width > 0 && r.height > 0,
            rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          });
        }
        return out;
      })()`);
      console.log(JSON.stringify(rows, null, 2));
      ws.close();
      return;
    }
    case 'html': {
      const selector = positional[0] || 'body';
      const chars = Number(positional[1] || 4000);
      const { ws, send } = await page(PORT);
      const out = await evalValue(send, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML.slice(0, ${chars}) : null; })()`, false);
      console.log(out === null ? `(no element for ${selector})` : out);
      ws.close();
      return;
    }
    case 'click': {
      const selector = positional[0];
      if (!selector) throw new Error('Usage: node dom.mjs click --port 9333 "<css selector>"');
      const { ws, send } = await page(PORT);
      const box = await evalValue(send, elementSelectorExpression(selector), false);
      if (!box) throw new Error(`No visible element for ${selector}`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await sleep(300);
      console.log(JSON.stringify({ ok: true, clicked: box }));
      ws.close();
      return;
    }
    case 'type': {
      const selector = positional[0];
      const text = positional[1] ?? '';
      if (!selector) throw new Error('Usage: node dom.mjs type --port 9333 "<css selector>" "texto" [--submit]');
      const { ws, send } = await page(PORT);
      const box = await evalValue(send, elementSelectorExpression(selector), false);
      if (!box) throw new Error(`No visible element for ${selector}`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, commands: ['selectAll'] });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
      if (text) await send('Input.insertText', { text });
      else await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      if (argv.includes('--submit')) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      }
      await sleep(200);
      console.log(JSON.stringify({ ok: true, typed: text, into: box.label }));
      ws.close();
      return;
    }
    case 'shot': {
      const file = flag('out', positional[0] || `shot-${Date.now()}.png`);
      const { ws, send } = await page(PORT);
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(file);
      ws.close();
      return;
    }
    case 'close': {
      const targets = await (await fetch(`${BASE}/json/list`)).json();
      for (const t of targets) await fetch(`${BASE}/json/close/${t.id}`).catch(() => {});
      console.log(`closed ${targets.length} target(s)`);
      return;
    }
    default:
      console.log(`CDP fallback for Chrome.

  launch  --port 9333 --dir <pasta> [--from "Profile 2"] [--url <url>]
  targets | open <url> | text [chars] | eval "<js>" | query "<sel>" [n]
  html "<sel>" [chars] | click "<sel>" | type "<sel>" "<txt>" [--submit] | shot [arquivo] | close
`);
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
