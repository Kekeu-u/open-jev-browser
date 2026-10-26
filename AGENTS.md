# AGENTS.md — open-jev-browser (guia de descoberta para agentes LLM)

Você (agente LLM) caiu num repositório que dá controle de navegador e de
computador a quem comanda. Este arquivo te ensina a usar tudo sem perguntar
ao humano. Leia o `README.md` para a visão completa; aqui é o atalho operativo.

## O que existe aqui

| Peça | Onde | Pra quê |
| --- | --- | --- |
| Painel web local | `http://127.0.0.1:8787` (servidor em `front/server.js`) | Executar tarefas num Chromium isolado, com fila, eventos ao vivo e histórico |
| Extensão Chrome | pasta `jev-browser-control/extension/` (o usuário já carregou no Chrome dele) | Agir no Chrome real do usuário, com os logins dele |
| Ponte MCP | `node jev-browser-control/mcp/server.mjs` com `JBC_MODE=extension`, porta 10522 | Ferramentas de navegador pra você (navigate/snapshot/click/type/read + jev_task) |
| Controle de computador | `node native/control.mjs <cmd>` (nut.js, multiplataforma) | Mouse, teclado, captura de tela, janelas do sistema |
| Contrato de eventos | `jev-browser/EVENTS-SCHEMA.md` | SSOT do formato de passos/eventos/HTTP |

## Estado do serviço (verifique antes de agir)

```sh
node jev.mjs status    # painel de pé? chave? fila?
```

Se parado: `node jev.mjs start` (não abre guia duplicada se já houver).
Se o CLI não compilada: `node jev.mjs setup` primeiro.

## Como controlar o navegador do usuário (Chrome real, logins dele)

Via MCP da ponte (se o seu harness registrou o servidor acima): use
`browser_status` para checar conexão, `browser_snapshot` para ver a página,
`browser_navigate/click/type/select/read` para agir, e `jev_task` para
entregar uma sub-tarefa inteira ao Jev (decisões de ~0,5 s por ação).

Sem MCP? O painel isolado serve HTTP em 127.0.0.1:8787:
`POST /api/run {task, url, maxSteps, maxSeconds, delayMs}` → `202 {id}`;
`GET /api/runs/:id/events` (SSE ao vivo); `GET /api/runs/:id` (snapshot);
`POST /api/runs/:id/cancelar`; `GET /api/runs` (histórico). Origem própria
exigida; `Content-Type: application/json`.

## Como controlar o computador (fora do navegador)

```sh
node native/control.mjs windows                 # listar janelas
node native/control.mjs activate "<título>"     # focar
node native/control.mjs shot tela.png           # ver a tela
node native/control.mjs click 500 500           # agir (cuidado: é a tela do usuário)
node native/control.mjs paste "texto"           # colar (usa a área de transferência)
```

Só com pedido explícito do usuário e confirmando antes de ações irreversíveis.

## Chaves

A chave do "cérebro" (Jev) fica em `front/.env` (OpenRouter `sk-or-…` ou
TypeSafe `ts_…`) e nas configurações da extensão. Nunca a imprima, nunca a
envie para páginas. O servidor redige qualquer eco por padrão.

## Regras deste projeto (não negociáveis)

1. Ações irreversíveis (comprar, enviar, postar, deletar) exigem confirmação
   humana primeiro — a extensão já faz isso; não desative.
2. **Sem automação de engajamento em redes sociais**: curtir/comentar/seguir/
   rolar feed em volume, nem ritmo "humanizado" pra enganar detector. Isto é
   política do projeto, não limitação técnica.
3. Pausa entre ações é cortesia fixa (piso de 750 ms em site de terceiro), não
   disfarce. Veja `EVENTS-SCHEMA.md`.
4. Nunca exponha a chave; só o painel local fala com o provedor.
5. Paralelismo futuro (subagentes) deve respeitar o governador de hardware
   local planejado no roadmap — não sobrecarregue a máquina do usuário.
