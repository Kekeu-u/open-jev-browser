// Front local para comandar o jev-browser (CLI) pelo navegador.
// Sem dependências: Node 22+, `node server.js` e pronto.
//
// Modelo do Sonnet: POST /api/run devolve 202 {id} na hora e enfileira a run
// (concorrência 1, teto MAX_QUEUE). A CLI emite um NDJSON por passo no stderr
// (--events); o server acumula no run e distribui por SSE
// (GET /api/runs/:id/events). GET /api/runs/:id é snapshot (reconexão e
// fallback de polling); GET /api/runs lista o histórico (memória + disco);
// POST /api/runs/:id/cancelar cancela. Cada run vira runs/<id>.json ao lado
// do .jpg; retenção KEEP_RUNS. A chave fica em .env e nunca vai pra página.

const http = require("http");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const REPO = path.resolve(ROOT, "..", "jev-browser");
const CLI = path.join(REPO, "dist", "index.js");
const RUNS = path.join(ROOT, "runs");
const PIDFILE = path.join(RUNS, ".child.pid");
const SERVER_PIDFILE = path.join(RUNS, ".server.pid");
let PORT = Number(process.env.FRONT_PORT || 8787);
const KEEP_RUNS = 20;
const MAX_BODY = 100000;
const MAX_STDOUT = 1000000;
const MAX_QUEUE = 10;

for (const p of [CLI, path.join(REPO, "node_modules")]) {
  if (!fs.existsSync(p)) {
    console.error(`Falta ${p}. Rode npm install && npm run build dentro de ${REPO}.`);
    process.exit(1);
  }
}
fs.mkdirSync(RUNS, { recursive: true });

function readEnvFile() {
  const file = path.join(ROOT, ".env");
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

// A chave é do "cérebro" (o modelo Jev): OpenRouter (sk-or-…) ou TypeSafe (ts_…).
// Uma só fica ativa por vez — ao salvar uma, a outra sai do .env.
function providerAtivo(envFile) {
  if (envFile.OPENROUTER_API_KEY) return "openrouter";
  if (envFile.TYPESAFE_API_KEY) return "typesafe";
  return null;
}

function childEnv(delayMs) {
  const envFile = readEnvFile();
  const provider = providerAtivo(envFile) || "openrouter";
  const env = { ...process.env, ...envFile, JEV_PROVIDER: provider };
  if (delayMs > 0) env.JEV_BROWSER_ACTION_DELAY_MS = String(delayMs);
  else delete env.JEV_BROWSER_ACTION_DELAY_MS;
  return env;
}

// Grava a chave no .env preservando as outras variáveis (FAST_HOSTS etc.)
// e removendo a chave do outro provedor, pra nunca haver dúvida de qual vale.
function writeEnvKey(alvo, key) {
  const file = path.join(ROOT, ".env");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const alvoVar = alvo === "typesafe" ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY";
  const out = [];
  for (const line of lines) {
    if (/^\s*(OPENROUTER_API_KEY|TYPESAFE_API_KEY)\s*=/.test(line)) continue;
    if (line.trim() !== "") out.push(line);
  }
  out.push(`${alvoVar}=${key}`);
  fs.writeFileSync(file, out.join("\n") + "\n");
  try { fs.chmodSync(file, 0o600); } catch {} // POSIX; no Windows é no-op
}

// Prévia mascarada — o que a página pode ver da chave, nada mais.
function keyPreview(k) {
  return k.length > 16 ? `${k.slice(0, 11)}…${k.slice(-4)}` : "***";
}

// Nunca ecoar a chave: erros do provedor podem refletir o header Authorization.
function redact(s) {
  const envFile = readEnvFile();
  let out = String(s);
  for (const k of [envFile.OPENROUTER_API_KEY, envFile.TYPESAFE_API_KEY]) {
    if (k) out = out.split(k).join("[redacted]");
  }
  return out
    .replace(/sk-or-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/ts_[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]");
}

// Matar só o pai deixaria o Chromium órfão no Windows; taskkill /T derruba a
// árvore. Caminho absoluto porque o libuv procura executável no cwd antes do
// PATH; fallback se taskkill faltar ou falhar.
function killTree(child) {
  if (!child || child.pid == null || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    const fallback = () => { try { child.kill("SIGKILL"); } catch {} };
    try {
      const tk = spawn(exe, ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      tk.on("error", fallback);
      tk.on("close", (c) => { if (c !== 0) fallback(); });
      return;
    } catch {}
  }
  try { child.kill("SIGKILL"); } catch {}
}

// Restart do servidor por crash deixaria CLI e Chromium rodando; o pidfile
// permite o próximo boot colher o órfão. Checagem da imagem do processo pra
// não matar um PID reciclado.
function reapStale() {
  let pid;
  try { pid = Number(fs.readFileSync(PIDFILE, "utf8")); fs.unlinkSync(PIDFILE); } catch { return; }
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return;
  try {
    const q = spawnSync(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tasklist.exe"),
      ["/FI", `PID eq ${pid}`, "/FI", "IMAGENAME eq node.exe", "/NH"],
      { encoding: "utf8", windowsHide: true },
    );
    if (/node\.exe/i.test(q.stdout || "")) {
      spawn(
        path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
        ["/pid", String(pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      ).on("error", () => {});
    }
  } catch {}
}
reapStale();

// Pausa entre ações: presets vêm do front, mas o PISO é imposto aqui — site de
// terceiro nunca fica sem pausa. "Rápido" (0) só vale pra hosts próprios
// (localhost/127.x/*.local) ou FAST_HOSTS no .env.
function isOwnHost(url) {
  try {
    const h = new URL(url).hostname;
    const fast = (readEnvFile().FAST_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
    return h === "localhost" || h === "::1" || h === "[::1]" || /^127\./.test(h) || h === "0.0.0.0" || h.endsWith(".local") || fast.includes(h);
  } catch { return false; }
}

function sameOrigin(req, strict) {
  const host = req.headers.host || "";
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return false;
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && !(site === "none" && !strict)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return false;
  return true;
}

// ---------- modelo de run ----------

const runs = new Map();
const queue = [];
let activeRun = null;
let activeChild = null;

// Guias do painel conectadas: cada aba aberta mantém um EventSource no
// /api/heartbeat; fechei a aba, a conexão cai e o contador baixa. É assim que
// o supervisor sabe se vale a pena abrir nova guia.
const uiClients = new Set();
function broadcastGuias() {
  const frame = `data: ${JSON.stringify({ type: "guias", n: uiClients.size })}\n\n`;
  for (const res of uiClients) { try { res.write(frame); } catch {} }
}

function runSnapshot(run) {
  return {
    id: run.id, task: run.task, url: run.url, status: run.status,
    error: run.error, stderrTail: run.stderrTail,
    maxSteps: run.maxSteps, maxSeconds: run.maxSeconds, delayMs: run.delayMs,
    createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
    events: run.events, result: run.result,
  };
}

function persistRun(run) {
  try {
    fs.writeFileSync(path.join(RUNS, `${run.id}.json`), JSON.stringify({
      id: run.id, task: run.task, url: run.url, status: run.status,
      error: run.error, createdAt: run.createdAt, finishedAt: run.finishedAt,
      shot: run.shotBasename, events: run.events, result: run.result,
    }));
  } catch {}
}

function cleanupRuns() {
  try {
    const files = fs.readdirSync(RUNS).filter((f) => f.endsWith(".json") && !f.startsWith("."));
    const stats = files.map((f) => ({ f, t: fs.statSync(path.join(RUNS, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of stats.slice(KEEP_RUNS)) {
      try {
        const old = JSON.parse(fs.readFileSync(path.join(RUNS, x.f), "utf8"));
        if (old.shot) { try { fs.unlinkSync(path.join(RUNS, old.shot)); } catch {} }
        fs.unlinkSync(path.join(RUNS, x.f));
      } catch {}
    }
  } catch {}
  // Memória também não cresce sem teto: runs terminais além do teto saem do Map.
  const terminal = [...runs.values()].filter((r) => r.status !== "queued" && r.status !== "running")
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  for (const r of terminal.slice(KEEP_RUNS)) runs.delete(r.id);
}

function sendTo(run, obj) {
  const frame = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of run.listeners) {
    try { res.write(frame); } catch {}
  }
}

function setRunStatus(run, status) {
  run.status = status;
  sendTo(run, { type: "status", status });
}

let heartbeat = null;
function ensureHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const run of runs.values()) {
      for (const res of run.listeners) { try { res.write(": hb\n\n"); } catch {} }
    }
    for (const res of uiClients) { try { res.write(": hb\n\n"); } catch {} }
  }, 15000);
  heartbeat.unref();
}

function pump() {
  if (activeRun || queue.length === 0) return;
  const id = queue.shift();
  const run = runs.get(id);
  if (!run || run.status !== "queued") return pump();
  startRun(run);
}

function startRun(run) {
  activeRun = run;
  run.startedAt = Date.now();
  setRunStatus(run, "running");
  persistRun(run);

  const shot = path.join(RUNS, `run-${Date.now()}.jpg`);
  run.shotBasename = path.basename(shot);
  const liveShot = path.join(RUNS, `${run.id}-live.jpg`);
  const args = [
    CLI, "run", run.task, run.url,
    "--format", "markdown",
    "--screenshot", shot,
    "--max-steps", String(run.maxSteps),
    "--max-seconds", String(run.maxSeconds),
    "--events",
    "--live-shot", liveShot,
  ];
  // Só a TypeSafe na chave = sem provedor de digitação (a TypeSafe não é um);
  // a menos que o usuário tenha configurado JEV_BROWSER_TYPE_* no .env.
  {
    const envFile = readEnvFile();
    const typingConfigured = envFile.JEV_BROWSER_TYPE_PROVIDER || envFile.JEV_BROWSER_TYPE_API_KEY || envFile.JEV_BROWSER_TYPE_BASE_URL;
    if (!envFile.OPENROUTER_API_KEY && envFile.TYPESAFE_API_KEY && !typingConfigured) args.push("--no-typing");
  }
  // windowsHide: sem isso o Windows abre um console VISÍVEL pra cada execução,
  // porque este servidor roda sem console próprio (spawn detached do supervisor).
  const child = spawn(process.execPath, args, { env: childEnv(run.delayMs), windowsHide: true });
  activeChild = child;
  run.child = child;
  try { fs.writeFileSync(PIDFILE, String(child.pid)); } catch {}

  let stdout = "", stderrTail = "", lineBuf = "", stdoutTruncated = false, done = false;
  const killer = setTimeout(() => killTree(child), (run.maxSeconds + 60) * 1000);

  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(killer);
    try { fs.unlinkSync(path.join(RUNS, `${run.id}-live.jpg`)); } catch {}
    run.finishedAt = Date.now();
    if (run.cancelRequested) run.status = "cancelled";
    else if (run.status === "running") run.status = run.result ? "done" : "failed";
    run.child = null;
    activeRun = null;
    activeChild = null;
    try { fs.unlinkSync(PIDFILE); } catch {}
    persistRun(run);
    cleanupRuns();
    sendTo(run, { type: "end", status: run.status, error: run.error });
    for (const res of run.listeners) { try { res.end(); } catch {} }
    run.listeners.clear();
    pump();
  };

  child.stdout.on("data", (d) => {
    if (stdout.length < MAX_STDOUT) stdout += d;
    else stdoutTruncated = true;
  });

  // Linhas NDJSON de --events viram eventos do run; o resto de stderr é o
  // buffer de erro humano.
  child.stderr.on("data", (d) => {
    lineBuf += d;
    let idx;
    while ((idx = lineBuf.indexOf("\n")) !== -1) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      let ev = null;
      try { ev = JSON.parse(line); } catch {}
      if (ev && typeof ev === "object" && !Array.isArray(ev) && ev.step != null) {
        run.events.push(ev);
        sendTo(run, { type: "step", step: ev });
      } else {
        stderrTail += line + "\n";
        if (stderrTail.length > 8000) stderrTail = stderrTail.slice(-8000);
      }
    }
  });

  child.on("error", (err) => {
    run.error = "Falha ao iniciar a CLI: " + err.message;
    run.stderrTail = redact(stderrTail.slice(-2000));
    finish();
  });

  child.on("close", (code) => {
    let result = null;
    try {
      result = JSON.parse(stdout.trim());
    } catch {
      const a = stdout.indexOf("{"), b = stdout.lastIndexOf("}");
      if (a !== -1 && b > a) { try { result = JSON.parse(stdout.slice(a, b + 1)); } catch {} }
    }
    if (result && typeof result === "object" && !Array.isArray(result)) {
      try { result = JSON.parse(redact(JSON.stringify(result))); } catch {}
      if (result) {
        result.screenshot = fs.existsSync(shot) ? "/runs/" + run.shotBasename : null;
        run.result = result;
        // O status da CLI manda: done/goal_achieved → done; max_steps/timeout/
        // stuck/blocked/error passam como estão pro painel.
        if (typeof result.status === "string" && result.status) {
          run.status = result.status === "goal_achieved" ? "done" : result.status;
        }
      }
    }
    if (!run.result) {
      if (!run.error) {
        run.error = run.cancelRequested
          ? "Cancelado."
          : `A CLI saiu com código ${code}.` + (stdoutTruncated ? " (saída truncada no meio)" : "");
      }
      run.stderrTail = redact(stderrTail.slice(-2000));
    }
    finish();
  });
}

function enqueueRun(body, cb) {
  const task = String(body.task || "").replace(/\0/g, "").trim().slice(0, 4000);
  let url = String(body.url || "").replace(/\0/g, "").trim().slice(0, 2000);
  const maxSteps = Math.min(Math.max(Number(body.maxSteps) || 24, 1), 60);
  const maxSeconds = Math.min(Math.max(Number(body.maxSeconds) || 180, 10), 900);
  const requested = body.delayMs == null || body.delayMs === "" ? 800 : Number(body.delayMs);

  if (!task) return cb({ status: 400, error: "Descreva a tarefa." });
  if (!url) return cb({ status: 400, error: "Informe a URL inicial." });
  if (task.startsWith("-") || url.startsWith("-")) {
    return cb({ status: 400, error: "Tarefa e URL não podem começar com \"-\"." });
  }
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  if (queue.length >= MAX_QUEUE) return cb({ status: 429, error: "Fila cheia; espere terminar uma execução." });

  const envFile = readEnvFile();
  if (!envFile.OPENROUTER_API_KEY && !envFile.TYPESAFE_API_KEY) {
    return fail(400, "Sem chave do cérebro (OpenRouter ou TypeSafe) — defina pelo painel ou no front/.env.");
  }

  const floor = isOwnHost(url) ? 0 : 750;
  const delayMs = Math.min(Math.max(Number.isFinite(requested) ? requested : 800, floor), 10000);

  const run = {
    id: crypto.randomUUID(),
    task, url, maxSteps, maxSeconds, delayMs,
    status: "queued", events: [], result: null, error: null, stderrTail: null,
    createdAt: Date.now(), startedAt: null, finishedAt: null,
    cancelRequested: false, listeners: new Set(), child: null, shotBasename: null,
  };
  runs.set(run.id, run);
  queue.push(run.id);
  persistRun(run);
  pump();
  cb({ status: 202, id: run.id, runStatus: run.status, queue: queue.length });
}

// Run órfã em disco de um boot anterior: nada está rodando de verdade.
function markStaleRuns() {
  try {
    for (const f of fs.readdirSync(RUNS).filter((x) => x.endsWith(".json") && !x.startsWith("."))) {
      try {
        const p = path.join(RUNS, f);
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        if (data.status === "queued" || data.status === "running") {
          data.status = "interrupted";
          data.error = data.error || "O servidor reiniciou durante a execução.";
          fs.writeFileSync(p, JSON.stringify(data));
        }
      } catch {}
    }
  } catch {}
}
markStaleRuns();

function listRuns() {
  const seen = new Map();
  for (const run of runs.values()) {
    seen.set(run.id, { id: run.id, task: run.task, status: run.status, createdAt: run.createdAt });
  }
  try {
    for (const f of fs.readdirSync(RUNS).filter((x) => x.endsWith(".json") && !x.startsWith("."))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(RUNS, f), "utf8"));
        if (!seen.has(data.id)) {
          seen.set(data.id, { id: data.id, task: data.task, status: data.status, createdAt: data.createdAt });
        }
      } catch {}
    }
  } catch {}
  return [...seen.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 50);
}

function snapshotById(id) {
  const run = runs.get(id);
  if (run) return runSnapshot(run);
  try {
    return JSON.parse(fs.readFileSync(path.join(RUNS, `${id}.json`), "utf8"));
  } catch { return null; }
}

// ---------- HTTP ----------

// Corpo JSON com teto de tamanho, compartilhado pelas rotas POST: sem
// application/json responde 415; estourou MAX_BODY, responde 413 e devolve
// null; JSON inválido vira {} (cada rota valida os campos que usa).
function readJsonBody(req, res, cb) {
  if (!/application\/json/i.test(req.headers["content-type"] || "")) {
    res.writeHead(415, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Content-Type precisa ser application/json." }));
  }
  let raw = "", tooBig = false;
  req.on("data", (d) => {
    if (tooBig) return;
    raw += d;
    if (raw.length > MAX_BODY) {
      tooBig = true;
      raw = "";
      res.writeHead(413, { "Content-Type": "application/json", "Connection": "close" });
      res.end(JSON.stringify({ error: "Corpo da requisição grande demais." }), () => req.destroy());
    }
  });
  req.on("end", () => {
    if (tooBig) return;
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
    cb(body);
  });
}

const server = http.createServer((req, res) => {
  let u;
  try {
    // Só origin-form ("/caminho"): "//…" é protocol-relative e "http://…" é
    // absolute-form — new URL("//", base) lança e nenhuma rota precisa disso.
    if (!/^\/(?!\/)/.test(req.url || "")) throw new Error("bad request");
    u = new URL(req.url, "http://127.0.0.1");
  } catch {
    res.writeHead(400);
    return res.end("bad request");
  }
  if (!sameOrigin(req, u.pathname !== "/")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Origem não permitida." }));
  }

  if (req.method === "GET" && u.pathname === "/") {
    try {
      const html = fs.readFileSync(path.join(ROOT, "index.html"));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(html);
    } catch {
      res.writeHead(500); res.end("index.html não encontrado");
    }
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/heartbeat") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write("retry: 3000\n\n");
    uiClients.add(res);
    ensureHeartbeat();
    broadcastGuias();
    res.on("close", () => { uiClients.delete(res); broadcastGuias(); });
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/status") {
    const envFile = readEnvFile();
    const key = envFile.OPENROUTER_API_KEY || envFile.TYPESAFE_API_KEY || null;
    const hasKey = Boolean(key);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      hasKey,
      keyPreview: hasKey ? keyPreview(key) : null,
      running: Boolean(activeRun),
      queued: queue.length,
      guias: uiClients.size,
      pid: process.pid,
    }));
  }

  // Configuração da chave pelo painel: valida com o provedor ANTES de gravar.
  // Sem rede: salva com aviso. Chave rejeitada (401/403): não grava nada.
  if (req.method === "POST" && u.pathname === "/api/chave") {
    readJsonBody(req, res, async (body) => {
      const chave = typeof body.chave === "string" ? body.chave.trim() : "";
      let alvo = null;
      if (/^sk-or-[A-Za-z0-9_-]{10,}$/.test(chave)) alvo = "openrouter";
      else if (/^ts_[A-Za-z0-9_-]{10,}$/.test(chave)) alvo = "typesafe";
      if (!alvo) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Formato não reconhecido — chave do OpenRouter (sk-or-…) ou da TypeSafe (ts_…)." }));
      }
      // Só o OpenRouter tem endpoint de validação que conhecemos; TypeSafe
      // salva direto (o primeiro run confirma se funciona).
      let validada = null; // null = sem validação, true = ok, false = rejeitada
      if (alvo === "openrouter") {
        const checkUrl = readEnvFile().OPENROUTER_KEY_CHECK_URL || process.env.OPENROUTER_KEY_CHECK_URL || "https://openrouter.ai/api/v1/auth/key";
        try {
          const r = await fetch(checkUrl, {
            headers: { Authorization: `Bearer ${chave}` },
            signal: AbortSignal.timeout(6000),
          });
          if (r.status === 401 || r.status === 403) validada = false;
          else validada = true;
        } catch {
          validada = null;
        }
        if (validada === false) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "O OpenRouter rejeitou essa chave (401/403). Confira em openrouter.ai/settings/keys." }));
        }
      }
      try {
        writeEnvKey(alvo, chave);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Falha ao gravar o front/.env: " + (e && e.message) }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        provedor: alvo,
        keyPreview: keyPreview(chave),
        validada,
        aviso: validada === null
          ? (alvo === "openrouter"
            ? "Sem rede para validar agora; chave salva mesmo assim."
            : "Chave TypeSafe salva sem validação automática — o primeiro run confirma.")
          : null,
      }));
    });
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/runs") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ runs: listRuns() }));
  }

  const runMatch = u.pathname.match(/^\/api\/runs\/([0-9a-f-]{36})(\/events|\/cancelar)?$/);
  if (runMatch) {
    const id = runMatch[1];
    const action = runMatch[2] || "";

    if (req.method === "GET" && !action) {
      const snap = snapshotById(id);
      if (!snap) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(snap));
    }

    if (req.method === "GET" && action === "/events") {
      const run = runs.get(id);
      if (!run) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write("retry: 2000\n\n");
      for (const ev of run.events) res.write(`data: ${JSON.stringify({ type: "step", step: ev })}\n\n`);
      if (run.status === "queued" || run.status === "running") {
        res.write(`data: ${JSON.stringify({ type: "status", status: run.status })}\n\n`);
        run.listeners.add(res);
        ensureHeartbeat();
        res.on("close", () => run.listeners.delete(res));
      } else {
        res.write(`data: ${JSON.stringify({ type: "end", status: run.status, error: run.error })}\n\n`);
        res.end();
      }
      return;
    }

    if (req.method === "POST" && action === "/cancelar") {
      const run = runs.get(id);
      if (!run || run.status === "cancelled" || run.status === "done" || run.status === "failed" || run.status === "interrupted") {
        res.writeHead(409, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Run inexistente ou já encerrada." }));
      }
      if (run.status === "queued") {
        const qi = queue.indexOf(id);
        if (qi !== -1) queue.splice(qi, 1);
        run.finishedAt = Date.now();
        setRunStatus(run, "cancelled");
        persistRun(run);
        sendTo(run, { type: "end", status: run.status, error: "Cancelado na fila." });
        for (const r of run.listeners) { try { r.end(); } catch {} }
        run.listeners.clear();
      } else {
        run.cancelRequested = true;
        killTree(run.child);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, id }));
    }
  }

  if (req.method === "POST" && u.pathname === "/api/run") {
    readJsonBody(req, res, (body) => {
      enqueueRun(body, (payload) => {
        res.writeHead(payload.status, { "Content-Type": "application/json" });
        if (payload.status === 202) {
          res.end(JSON.stringify({ id: payload.id, status: payload.runStatus, queue: payload.queue }));
        } else {
          res.end(JSON.stringify({ error: payload.error }));
        }
      });
    });
    return;
  }

  if (req.method === "GET" && u.pathname.startsWith("/runs/")) {
    let name = "";
    try { name = decodeURIComponent(u.pathname.slice(6)); } catch {}
    if (!/^run-\d+\.jpg$/.test(name) && !/^[0-9a-f-]{36}-live\.jpg$/.test(name)) {
      res.writeHead(404); return res.end("not found");
    }
    try {
      const buf = fs.readFileSync(path.join(RUNS, name));
      res.writeHead(200, { "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff" });
      res.end(buf);
    } catch {
      res.writeHead(404); res.end("not found");
    }
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  // FRONT_PORT=0: o sistema escolheu a porta — guardas de origem e log passam
  // a usar a real da escuta.
  PORT = server.address().port;
  try { fs.writeFileSync(SERVER_PIDFILE, String(process.pid)); } catch {}
  console.log(`jev front em http://127.0.0.1:${PORT}`);
});

function shutdown() {
  if (activeRun) {
    activeRun.status = "interrupted";
    activeRun.error = "O servidor foi desligado durante a execução.";
    activeRun.finishedAt = Date.now();
    persistRun(activeRun);
  }
  killTree(activeChild);
  try { fs.unlinkSync(SERVER_PIDFILE); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
for (const s of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(s, shutdown);

// Rede de segurança: morrer limpo (sem CLI órfã) em vez de seguir inconsistente.
process.on("uncaughtException", (e) => {
  try { console.error("fatal:", e && e.message); } catch {}
  if (activeRun) {
    try {
      activeRun.status = "interrupted";
      activeRun.finishedAt = Date.now();
      persistRun(activeRun);
    } catch {}
  }
  killTree(activeChild);
  try { fs.unlinkSync(SERVER_PIDFILE); } catch {}
  process.exit(1);
});
