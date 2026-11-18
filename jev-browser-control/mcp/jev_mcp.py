"""Cliente MCP minimo (stdio) para o jev-browser-control em modo extensao.

Sobe o server.mjs, conecta o MCP, e executa uma sequencia de passos.
Uso: python jev_mcp.py "<json com passos>"
Imprime o resultado de cada passo.
"""
import json
import os
import subprocess
import sys
import time

MCP_DIR = r"C:\apps\open-jev-browser\jev-browser-control\mcp"
NODE = "node"


class MCP:
    def __init__(self, cwd):
        env = dict(os.environ)
        env["JBC_MODE"] = "extension"          # usa a extensao do Chrome do usuario
        self.p = subprocess.Popen(
            [NODE, "server.mjs"],
            cwd=cwd, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
        )
        self._id = 0

    def send(self, method, params=None, notify=False):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        if not notify:
            self._id += 1
            msg["id"] = self._id
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        return None if notify else self._read(msg["id"])

    def _read(self, want_id, timeout=120):
        t0 = time.time()
        while time.time() - t0 < timeout:
            line = self.p.stdout.readline()
            if not line:
                err = self.p.stderr.read()[:800] if self.p.stderr else ""
                raise RuntimeError("server encerrou. stderr: " + err)
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("id") == want_id:
                if "error" in obj:
                    raise RuntimeError(f"erro MCP: {obj['error']}")
                return obj.get("result", {})
        raise TimeoutError(f"sem resposta para id={want_id}")

    def init(self):
        r = self.send("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "athena-local", "version": "1.0"},
        })
        self.send("notifications/initialized", notify=True)
        return r

    def tools(self):
        return self.send("tools/list", {})

    def call(self, name, args=None):
        return self.send("tools/call", {"name": name, "arguments": args or {}})

    def close(self):
        try:
            self.p.terminate()
        except Exception:
            pass


def main():
    passos = json.loads(sys.argv[1])
    m = MCP(MCP_DIR)
    out = {}
    try:
        m.init()
        for passo in passos:
            tool, args = passo["tool"], passo.get("args", {})
            tentativas = int(passo.get("retries", 1))
            espera = float(passo.get("wait_s", 3))
            for t in range(tentativas):
                try:
                    r = m.call(tool, args)
                    content = r.get("content", r)
                    txt = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
                    out[tool] = txt[:2500]
                    print(f"\n### {tool} -> ok (tentativa {t+1})")
                    print(txt[:1500])
                    if "not connected" in txt and t + 1 < tentativas:
                        print("   extensao ainda nao conectada, aguardando...")
                        time.sleep(espera)
                        continue
                    break
                except Exception as e:
                    out[tool] = "ERRO: " + str(e)
                    print(f"\n### {tool} -> {e}")
                    if t + 1 < tentativas:
                        time.sleep(espera)
                        continue
                    break
        print("\n=== RESUMO ===")
        print(json.dumps(out, ensure_ascii=False)[:3000])
    finally:
        m.close()


if __name__ == "__main__":
    main()
