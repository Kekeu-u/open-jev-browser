#!/usr/bin/env node
// Supervisor do serviço jev browser — start / stop / status / setup.
// Multiplataforma (Windows, macOS, Linux). Isolamento: o servidor roda com
// pidfile próprio; `stop` encerra a cadeia inteira (servidor → CLI → Chromium)
// sem deixar processo órfão. Log da sessão em front/runs/server.log.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync, copyFileSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import process from "node:process";

const ROOT = dirname(fileURLToPath(import.meta.url));
const FRONT = join(ROOT, "front");
const RUNS = join(FRONT, "runs");
const REPO = join(ROOT, "jev-browser");
const SERVER = join(FRONT, "server.js");
const PIDFILE = join(RUNS, ".server.pid");
const LOG = join(RUNS, "server.log");
const PORT = Number(process.env.FRONT_PORT || 8787);
const URL = `http://127.0.0.1:${PORT}`;
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const say = (msg) => console.log(msg);
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

function nodeVersionOk() {
  const [maj] = process.versions.node.split(".").map(Number);
  return maj >= 22;
}

async function status() {
  try {
    const r = await fetch(`${URL}/api/status`, { signal: AbortSignal.timeout(1200) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function readPidfile() {
  try { return Number(readFileSync(PIDFILE, "utf8")); } catch { return null; }
}

function openBrowser(url) {
  try {
    if (IS_WIN) {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else if (IS_MAC) {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {}
}

// Derruba a árvore inteira: no Windows taskkill /T /F; no POSIX mata o grupo
// (o servidor sobe detached, logo tem grupo próprio) com TERM e depois KILL.
function killTree(pid) {
  if (!pid || pid <= 0) return;
  if (IS_WIN) {
    const exe = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    try {
      spawnSync(exe, ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  } else {
    for (const sig of ["SIGTERM", "SIGKILL"]) {
      try { process.kill(-pid, sig); } catch {}
      try { process.kill(pid, sig); } catch {}
      sleepMs(600);
    }
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function cmdSetup() {
  if (!nodeVersionOk()) return die(`Precisa de Node 22+ (voce esta no ${process.versions.node}).`);
  say("- Instalando dependencias da CLI (jev-browser)...");
  const npm = IS_WIN ? "npm.cmd" : "npm";
  const r1 = spawnSync(npm, ["install"], { cwd: REPO, stdio: "inherit", shell: IS_WIN });
  if (r1.status !== 0) return die("npm install falhou em jev-browser/.");
  say("- Compilando a CLI...");
  const r2 = spawnSync(npm, ["run", "build"], { cwd: REPO, stdio: "inherit", shell: IS_WIN });
  if (r2.status !== 0) return die("build falhou em jev-browser/.");
  say("- Baixando o Chromium da Playwright (pula sozinho se ja existir)...");
  const r3 = spawnSync(npm, ["exec", "playwright", "install", "chromium"], { cwd: REPO, stdio: "inherit", shell: IS_WIN });
  if (r3.status !== 0) return die("playwright install chromium falhou.");
  const envPath = join(FRONT, ".env");
  if (!existsSync(envPath)) {
    copyFileSync(join(FRONT, ".env.example"), envPath);
    say("- Criei front/.env a partir do exemplo.");
    say("  AGORA COLE SUA CHAVE DO OPENROUTER dentro dele (openrouter.ai/settings/keys).");
  }
  say("\nSetup completo. Suba o servico com:  node jev.mjs start");
}

async function cmdStart() {
  if (!nodeVersionOk()) return die(`Precisa de Node 22+ (você está no ${process.versions.node}).`);
  if (!existsSync(SERVER)) return die("front/server.js não encontrado — rode da raiz do projeto.");
  if (!existsSync(join(REPO, "dist", "index.js"))) {
    return die("CLI não compilada. Rode primeiro:  node jev.mjs setup");
  }
  if (!existsSync(join(FRONT, ".env"))) {
    say("[!] front/.env nao existe - configure a chave pelo painel");
    say("    (link 'chave' no topo da pagina) ou crie a partir de front/.env.example.");
  }

  // Instância única + guia única: painel já aberto em alguma guia (batimento
  // ativo) não ganha outra; só avisamos onde ele está.
  const already = await status();
  if (already && already.pid) {
    if (already.guias > 0) {
      say(`Ja esta rodando (pid ${already.pid}) e o painel ja esta aberto em ${already.guias} guia(s) - nao abri outra.`);
    } else {
      say(`Ja esta rodando (pid ${already.pid}). Abrindo ${URL} ...`);
      openBrowser(URL);
    }
    return;
  }

  // Log da sessão com teto: acima de 1 MB, recomeça.
  try {
    mkdirSync(RUNS, { recursive: true });
    if (existsSync(LOG) && statSync(LOG).size > 1_000_000) writeFileSync(LOG, "");
  } catch {}
  const logFd = (() => { try { return openSync(LOG, "a"); } catch { return "ignore"; } })();

  // Detached em TODAS as plataformas: o servidor escapa do grupo/console de
  // quem o lançou (fecha o terminal, o serviço continua). No POSIX vira grupo
  // próprio (kill -grupo no stop); no Windows, CREATE_NEW_PROCESS_GROUP.
  const child = spawn(process.execPath, [SERVER], {
    cwd: FRONT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: { ...process.env },
  });
  child.unref();
  say(`- Servidor subindo (pid ${child.pid})...`);

  for (let i = 0; i < 40; i++) {
    await sleepMs(250);
    const s = await status();
    if (s && s.pid) {
      say(`[ok] Painel em ${URL}  (pid ${s.pid})`);
      say(`  Parar tudo: node jev.mjs stop   |   ver estado: node jev.mjs status`);
      say(`  Log da sessao: front/runs/server.log`);
      if (s.guias > 0) {
        say(`  Painel ja aberto em ${s.guias} guia(s) - nao abri outra.`);
      } else {
        openBrowser(URL);
      }
      return;
    }
    if (child.exitCode !== null) {
      return die(`O servidor saiu logo ao subir (codigo ${child.exitCode}). Veja front/runs/server.log`);
    }
  }
  killTree(child.pid);
  die("O servidor nao respondeu em 10s. Veja front/runs/server.log.");
}

async function cmdStop() {
  const s = await status();
  if (!s || !s.pid) {
    try { if (existsSync(PIDFILE)) unlinkSync(PIDFILE); } catch {}
    return say("Nao esta rodando.");
  }
  const pid = s.pid;
  say(`- Parando servidor (pid ${pid}) e toda a arvore de processos...`);
  killTree(pid);
  for (let i = 0; i < 20; i++) {
    await sleepMs(300);
    const gone = await status();
    if (!gone) {
      try { if (existsSync(PIDFILE)) unlinkSync(PIDFILE); } catch {}
      return say("[ok] Parado. Nada ficou rodando (servidor, CLI e Chromium encerrados).");
    }
  }
  say("[!] Ainda respondeu apos o kill - confira manualmente o pid " + pid);
}

async function cmdStatus() {
  const s = await status();
  if (!s || !s.pid) {
    say("Parado. Suba com:  node jev.mjs start");
    return;
  }
  say(`Rodando: ${URL}  (pid ${s.pid})`);
  say(`  chave: ${s.hasKey ? "configurada" : "FALTANDO no front/.env"} | execucao em andamento: ${s.running ? "sim" : "nao"} | fila: ${s.queued}`);
}

function chromeRodando() {
  if (!IS_WIN) return false;
  try {
    const q = spawnSync(
      join(process.env.SystemRoot || "C:\\Windows", "System32", "tasklist.exe"),
      ["/FI", "IMAGENAME eq chrome.exe", "/NH"],
      { encoding: "utf8", windowsHide: true },
    );
    return /chrome\.exe/i.test(q.stdout || "");
  } catch { return false; }
}

async function cmdExtensao() {
  say("Preparando a instalacao da extensao no seu Chrome...");
  if (!existsSync(join(ROOT, "jev-browser-control", "extension", "manifest.json"))) {
    return die("Pasta jev-browser-control/extension nao encontrada.");
  }
  if (IS_WIN) {
    // Chrome em chrome://extensions — mas Chrome já aberto ignora URL externa
    // (mostra o seletor de perfis e descarta o endereço): nesse caso o endereço
    // vai pra área de transferência, é só colar na barra de endereço.
    const cands = [
      join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    ].filter(Boolean);
    const chrome = cands.find(existsSync);
    if (chrome && !chromeRodando()) {
      spawn(chrome, ["chrome://extensions"], { detached: true, stdio: "ignore" }).unref();
    } else if (chrome) {
      try {
        // clip síncrono: garantido na área de transferência antes do aviso
        spawnSync("cmd", ["/c", "echo chrome://extensions|clip"], { windowsHide: true, stdio: "ignore" });
        say("- Seu Chrome ja esta aberto: colei chrome://extensions na area de");
        say("  transferencia. Na barra de endereco do Chrome: Ctrl+V e Enter.");
      } catch {}
    } else {
      say("[!] Chrome nao achei nos lugares comuns - abra chrome://extensions na mao.");
    }
    // Pasta pronta pro "Carregar sem compactacao"
    spawn("explorer.exe", [join(ROOT, "jev-browser-control", "extension")], { detached: true, stdio: "ignore" }).unref();
    // A chave aberta pra copiar (se ja configurada no painel)
    if (existsSync(join(FRONT, ".env"))) {
      spawn("notepad.exe", [join(FRONT, ".env")], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      say("- Abri o Bloco de Notas com a chave (a linha OPENROUTER_API_KEY): copie ela.");
    } else {
      say("[!] Sem front/.env ainda - configure a chave no painel antes (ou copie de onde voce tem).");
    }
  } else {
    say(`Abra chrome://extensions e carregue sem compactacao a pasta:
  ${join(ROOT, "jev-browser-control", "extension")}`);
  }
  say("");
  say("Passos no Chrome (o resto e so clicar):");
  say("  1. Em chrome://extensions, ligue o Modo do desenvolvedor (cima a direita)");
  say("  2. Carregar sem compactacao -> selecione a pasta que abri no Explorer (extension)");
  say("  3. Pino do Jev na barra; clique nele -> Opcoes");
  say("  4. Escolha 'Your own OpenRouter key', cole a chave, Test connection");
  say("Pronto: painel lateral do Jev no SEU Chrome, com seus logins.");
}

// Ícone .ico a partir do PNG da extensão (formato ICO aceita PNG embutido).
function writeIcoFromPng(pngFile, icoFile) {
  const png = readFileSync(pngFile);
  const w = png.readUInt32BE(16) >= 256 ? 0 : png.readUInt32BE(16);
  const h = png.readUInt32BE(20) >= 256 ? 0 : png.readUInt32BE(20);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = w;
  header[7] = h;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  writeFileSync(icoFile, Buffer.concat([header, png]));
}

async function cmdAtalho() {
  const png = join(ROOT, "jev-browser-control", "extension", "icons", "icon48.png");
  if (IS_WIN) {
    const ico = join(RUNS, "jev.ico");
    try {
      if (existsSync(png) && !existsSync(ico)) writeIcoFromPng(png, ico);
    } catch {}
    // .lnk via PowerShell (arquivo .ps1 evita inferno de aspas); Desktop real
    // via GetFolderPath (funciona com OneDrive redirecionado).
    const ps1 = join(RUNS, "atalho.ps1");
    writeFileSync(ps1, [
      `$d = [Environment]::GetFolderPath('Desktop')`,
      `$ws = New-Object -ComObject WScript.Shell`,
      `$s = $ws.CreateShortcut("$d\\jev browser.lnk")`,
      `$s.TargetPath = "$env:JEV_ROOT\\start.bat"`,
      `$s.WorkingDirectory = "$env:JEV_ROOT"`,
      `$s.WindowStyle = 7`,
      `$s.Description = "Painel jev browser"`,
      `if (Test-Path "$env:JEV_ICO") { $s.IconLocation = "$env:JEV_ICO" }`,
      `$s.Save()`,
      `Write-Output $s.FullName`,
    ].join("\n"));
    const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, JEV_ROOT: ROOT, JEV_ICO: ico },
    });
    const out = (r.stdout || "").trim();
    if (r.status === 0 && out) {
      say(`[ok] Icone criado na area de trabalho: ${out}`);
    } else {
      say("[!] Nao consegui criar o atalho (" + ((r.stderr || "").trim().slice(0, 120) || "erro desconhecido") + ")");
    }
    return;
  }
  if (process.platform === "linux") {
    const dir = join(homedir(), ".local", "share", "applications");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "jev-browser.desktop"), [
        "[Desktop Entry]",
        "Type=Application",
        "Name=jev browser",
        `Exec=${process.execPath} ${join(ROOT, "jev.mjs")} start`,
        `Path=${ROOT}`,
        `Icon=${existsSync(png) ? png : ""}`,
        "Terminal=false",
        "Categories=Utility;",
      ].join("\n"));
      say("[ok] Atalho criado no menu de aplicativos (jev browser).");
    } catch {
      say("[!] Nao consegui criar o .desktop.");
    }
    return;
  }
  say("No macOS: use 'node jev.mjs start' no terminal, ou crie um app com Automator apontando pra esse comando.");
}

async function cmdTudo() {
  say("== jev: deixando tudo pronto ==");
  const faltaCli = !existsSync(join(REPO, "node_modules")) || !existsSync(join(REPO, "dist", "index.js"));
  if (faltaCli) {
    say("1/3 Instalando dependencias e compilando (so na primeira vez)...");
    await cmdSetup();
  } else {
    say("1/3 Dependencias ok.");
  }
  say("2/3 Icone na area de trabalho...");
  await cmdAtalho();
  say("3/3 Subindo o painel...");
  await cmdStart();
  say("");
  say("Proximos passos (so na primeira vez):");
  say("  - Chave do cerebro: botao 'chave' no topo do painel (sk-or-... ou ts_...)");
  say("  - Seu Chrome do dia a dia: node jev.mjs extensao");
  say("Dia a dia: clique no icone 'jev browser' na area de trabalho.");
}

// Registra o MCP jev-browser (modo extensão) nos agentes locais encontrados.
// Idempotente: entrada existente fica como está.
async function cmdConectar() {
  const serverPath = join(ROOT, "jev-browser-control", "mcp", "server.mjs");
  if (!existsSync(serverPath)) return die("mcp/server.mjs nao encontrado.");
  const home = homedir();
  let feitos = [];

  // ZCode: ~/.zcode/cli/config.json (mcp.servers)
  const zcPath = join(home, ".zcode", "cli", "config.json");
  try {
    if (existsSync(zcPath)) {
      const cfg = JSON.parse(readFileSync(zcPath, "utf8"));
      cfg.mcp ??= {};
      cfg.mcp.servers ??= {};
      if (cfg.mcp.servers["jev-browser"]) {
        say("- ZCode: ja registrado (mantido como esta).");
      } else {
        cfg.mcp.servers["jev-browser"] = {
          command: "node",
          args: [serverPath],
          env: { JBC_MODE: "extension" },
        };
        writeFileSync(zcPath, JSON.stringify(cfg, null, 2));
        say("- ZCode: registrado.");
      }
      feitos.push("zcode");
    }
  } catch (e) { say(`[!] ZCode: falhou (${e.message})`); }

  // Claude Code: ~/.claude.json (mcpServers no topo)
  const ccPath = join(home, ".claude.json");
  try {
    if (existsSync(ccPath)) {
      const cfg = JSON.parse(readFileSync(ccPath, "utf8"));
      cfg.mcpServers ??= {};
      if (cfg.mcpServers["jev-browser"]) {
        say("- Claude Code: ja registrado (mantido).");
      } else {
        cfg.mcpServers["jev-browser"] = {
          command: "node",
          args: [serverPath],
          env: { JBC_MODE: "extension" },
        };
        writeFileSync(ccPath, JSON.stringify(cfg, null, 2));
        say("- Claude Code: registrado.");
      }
      feitos.push("claude-code");
    }
  } catch (e) { say(`[!] Claude Code: falhou (${e.message})`); }

  // Codex: ~/.codex/config.toml (bloco [mcp_servers.jev-browser])
  const cxPath = join(home, ".codex", "config.toml");
  try {
    if (existsSync(cxPath)) {
      const cur = readFileSync(cxPath, "utf8");
      if (cur.includes("[mcp_servers.jev-browser]")) {
        say("- Codex: ja registrado (mantido).");
      } else {
        const bloco = [
          "",
          "[mcp_servers.jev-browser]",
          'command = "node"',
          `args = ["${serverPath.replace(/\\/g, "\\\\")}"]`,
          'env = { JBC_MODE = "extension" }',
          "",
        ].join("\n");
        writeFileSync(cxPath, cur.endsWith("\n") ? cur + bloco : cur + "\n" + bloco);
        say("- Codex: registrado.");
      }
      feitos.push("codex");
    }
  } catch (e) { say(`[!] Codex: falhou (${e.message})`); }

  if (!feitos.length) {
    say("Nenhum agente local conhecido encontrado (ZCode/Claude Code/Codex).");
    say("Registre manualmente: node <repo>/jev-browser-control/mcp/server.mjs com JBC_MODE=extension");
    return;
  }
  say("");
  say("[ok] Feito. Reinicie o agente para conectar. A extensao precisa estar");
  say("    carregada no Chrome e com 'bridge' ativo nas configuracoes dela.");
  say("    LLMs na nuvem (ChatGPT/claude.ai): ative 'Remote AI apps' nas opcoes da extensao.");
}

const cmd = (process.argv[2] || "start").toLowerCase();
const cmds = { setup: cmdSetup, start: cmdStart, stop: cmdStop, status: cmdStatus, extensao: cmdExtensao, atalho: cmdAtalho, tudo: cmdTudo, conectar: cmdConectar };
if (!cmds[cmd]) die(`Uso: node jev.mjs [tudo|start|stop|status|extensao|atalho|conectar|setup]  (default: start)`);
cmds[cmd]();
