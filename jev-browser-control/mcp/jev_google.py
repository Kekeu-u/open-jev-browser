"""Pesquisa no Google no Chrome REAL do usuario, via extensao jev-browser-control.

Fluxo: navigate -> snapshot -> acha ref do campo de busca -> type+submit -> read -> screenshot.
Salva o print em C:/apps/abacaxi-google.png e imprime URL + titulos.
"""
import base64
import json
import re
import sys

sys.path.insert(0, r"C:\apps\open-jev-browser\jev-browser-control\mcp")
from jev_mcp import MCP, MCP_DIR  # noqa: E402

TERMO = sys.argv[1] if len(sys.argv) > 1 else "abacaxi"
OUT_PNG = r"C:\apps\abacaxi-google.png"


def texto(result):
    itens = result.get("content") or []
    partes = [i.get("text", "") for i in itens if isinstance(i, dict) and i.get("type") == "text"]
    return "\n".join(partes)


def salva_imagem(result, path):
    for i in (result.get("content") or []):
        if isinstance(i, dict) and i.get("type") == "image":
            with open(path, "wb") as f:
                f.write(base64.b64decode(i["data"]))
            return True
    return False


def com_retry(fn, tentativas=25, espera=3):
    ultimo = None
    for t in range(tentativas):
        ultimo = fn()
        if "not connected" not in texto(ultimo):
            return ultimo
        print(f"   extensao desconectada, tentativa {t+1}...")
        import time
        time.sleep(espera)
    return ultimo


m = MCP(MCP_DIR)
try:
    m.init()

    r = com_retry(lambda: m.call("browser_navigate", {"url": "https://www.google.com/"}))
    snap = texto(r)
    print("URL:", re.search(r"https?://[^\s]+", snap).group(0) if re.search(r"https?://[^\s]+", snap) else "?")

    m.ref = None
    for linha in snap.splitlines():
        m_ = re.match(r"\[(\d+)\]\s+(textbox|combobox|searchbox)", linha, re.I)
        if m_:
            ref = int(m_.group(1))
            print("campo achado:", linha.strip()[:90])
            break
    else:
        print("nao achei o campo de busca; snapshot:")
        print(snap[:1200])
        raise SystemExit(1)

    r = m.call("browser_type", {"ref": ref, "text": TERMO, "submit": True})
    t = texto(r)
    url = re.search(r"^\S*https?://\S+", t, re.M)
    print("URL depois:", (url.group(0) if url else "?").strip())

    # resultados visiveis
    r2 = m.call("browser_snapshot", {"full": False})
    t2 = texto(r2)
    titulos = re.findall(r'\[(\d+)\] link "([^"]{12,90})"', t2)
    print("\nlinks visiveis (top 8):")
    for ref2, nome in titulos[:8]:
        print(f"  [{ref2}] {nome}")

    r3 = m.call("browser_screenshot", {"quality": 80})
    print("\nprint salvo:", salva_imagem(r3, OUT_PNG), OUT_PNG)
finally:
    m.close()
