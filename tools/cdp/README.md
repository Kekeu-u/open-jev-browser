# Fallback CDP — ler e agir no DOM quando a extensão não serve

`dom.mjs` fala direto com o Chrome pelo DevTools Protocol: DOM cru, `querySelector`, JS na página,
clique por seletor, teclar, screenshot. Sem dependências (Node 22: `fetch` + `WebSocket`), sem extensão,
sem MCP.

## Quando usar

- A extensão do jev está desconectando, com `ref` velho, ou não lê um componente (iframe, shadow DOM
  fechado, formulário que só reage a evento nativo).
- Você precisa do DOM de verdade (`outerHTML`, atributos, `value` real de um input) e não do retrato
  de acessibilidade.
- Quer inspecionar o estado de um app React antes de decidir o clique.

Para o fluxo normal do dia a dia continue com a extensão (`browser_batch`): ela age "como humano" no
Chrome do usuário, com as confirmações do projeto. Este é o plano B.

## Comandos

```powershell
# sobe um Chrome próprio com porta de depuração (perfil limpo)
node dom.mjs launch --port 9333 --dir C:\Users\supar\jbc-cdp --url https://example.com

# com os logins: copie o perfil com o Chrome FECHADO (o banco de cookies fica travado aberto)
node dom.mjs launch --port 9333 --dir C:\Users\supar\jbc-cdp --from "Profile 2"

node dom.mjs targets                        # abas/workers
node dom.mjs open   --port 9333 <url>
node dom.mjs text   --port 9333 4000        # innerText
node dom.mjs eval   --port 9333 "document.title"
node dom.mjs query  --port 9333 "a[href]" 20
node dom.mjs html   --port 9333 "form" 8000
node dom.mjs click  --port 9333 "#botao"
node dom.mjs type   --port 9333 "#busca" "texto" --submit
node dom.mjs shot   --port 9333 tela.png
node dom.mjs close
```

`--port` acompanha todo comando (default 9333, ou `CDP_PORT`).

## Limite do Chrome 136+

O Chrome ignora `--remote-debugging-port` quando o `--user-data-dir` é o perfil padrão — por isso
`launch` **sempre** usa um diretório próprio. Para usar os logins do usuário:

1. feche o Chrome;
2. rode `launch --from "Profile 2"` (copia `Local State` + o perfil, sem caches);
3. reabra o Chrome normal quando quiser — os dois convivem, são diretórios diferentes.

Copiar o perfil duplica cookies no disco local. Não versione esse diretório e apague quando não precisar.

## Diferenças para a extensão

| | Extensão (`browser_batch`) | Fallback CDP |
|---|---|---|
| Chrome do usuário | sim, a janela que já está aberta | instância própria, perfil copiado |
| DOM cru / JS na página | não | sim (`eval`, `query`, `html`) |
| Confirmação de ação irreversível | sim | **não** — você é responsável |
| Precisa recarregar a extensão | não | não |
