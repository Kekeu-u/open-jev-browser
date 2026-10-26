// Teste de fumaça do servidor do painel: sobe o server.js em porta efêmera e
// confere as rotas básicas (página com CSP, status, histórico, guardas de
// origem e Content-Type). Sem dependências: node --test test/ dentro de front/.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FRONT = dirname(dirname(fileURLToPath(import.meta.url)));

let child;
let BASE;

before(async () => {
  child = spawn(process.execPath, [join(FRONT, "server.js")], {
    cwd: FRONT,
    env: { ...process.env, FRONT_PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  // A porta efêmera só é conhecida pela linha que o servidor imprime ao abrir.
  BASE = `http://127.0.0.1:${await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("servidor do painel não anunciou a porta em 10s")), 10_000);
    child.stdout.on("data", (d) => {
      buf += String(d);
      const m = buf.match(/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on("exit", (c) => { clearTimeout(timer); reject(new Error(`servidor saiu cedo (código ${c})`)); });
  })}`;
});

after(() => {
  child?.kill("SIGKILL");
});

test("página do painel abre com CSP e HTML", async () => {
  const r = await fetch(BASE + "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/html/);
  assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(await r.text(), /<html/i);
});

test("GET /api/status expõe só o estado, nunca a chave", async () => {
  const r = await fetch(BASE + "/api/status");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(typeof body.hasKey, "boolean");
  assert.equal(typeof body.pid, "number");
  assert.equal("OPENROUTER_API_KEY" in body, false);
});

test("GET /api/runs devolve o histórico", async () => {
  const r = await fetch(BASE + "/api/runs");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray((await r.json()).runs));
});

test("origem estranha leva 403", async () => {
  const r = await fetch(BASE + "/api/status", {
    headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site" },
  });
  assert.equal(r.status, 403);
});

test("POST com Content-Type errado leva 415", async () => {
  const r = await fetch(BASE + "/api/run", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "x",
  });
  assert.equal(r.status, 415);
});
