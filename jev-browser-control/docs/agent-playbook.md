# Playbook: dirigir o jev browser sem tropeçar

Regras práticas que custaram tentativa e erro no uso real do modo extensão (Chrome do dia a dia).

## 1. Rótulo vale mais que número

`browser_snapshot` numera os elementos (`[n]`), mas **qualquer ação re-renderiza a página e os números
morrem**. Em página que se atualiza (Facebook, Meta, apps React) prefira `browser_batch` com `label`:
o servidor tira um snapshot novo e resolve o texto antes de cada passo.

```json
browser_batch { "steps": [
  { "action": "navigate", "url": "https://exemplo.com", "newTab": true },
  { "action": "click", "label": "Learn more" },
  { "action": "wait",  "ms": 1200 },
  { "action": "read",  "chars": 400 }
] }
```

Cada passo devolve uma linha `N. ação ok — detalhe` ou `N. ação FAILED — motivo`, e o batch para no
primeiro erro (use `continueOnError: true` para seguir). Passos aceitam `tabId`; depois de um
`navigate` o batch fica preso àquela aba, então ele não escorrega para outra guia sem querer.

## 2. Espere o conteúdo, não o relógio

`browser_wait_for { "text": "Pedrão Prime", "timeoutMs": 20000 }` (ou `regex`, ou `url`). Faz polling
do snapshot e devolve o que encontrou. Evita `sleep` chutado e o clássico "a página ainda não carregou".

## 3. Dropdown: nativo e custom

`browser_select { "label": "Cidade", "option": "Gravataí, RS" }` ou com `ref`. Se o campo for
`<select>` nativo, vai direto; se for combo custom (Meta/Facebook, Radix), ele **abre a lista, lê as
opções e clica na que casa** — antes isso devolvia "dropdown is gone".

## 4. Ler é diferente de clicar

- **Auditar conteúdo** → `browser_read` (markdown, com `offset`/`limit` para paginar).
- **Agir** → `browser_snapshot` + `click/type/press`.
- **Layout/imagem** → `browser_screenshot` (PNG por padrão; `format: "jpeg"` + `quality` quando o
  tamanho importa).

## 5. Abas e contexto

- `navigate` sem `newTab` reaproveita a aba atual do agente (`claudeTab`), que o servidor lembra entre
  chamadas. Em automação, prefira `newTab: true` e passe o `tabId` devolvido.
- `browser_tabs` lista tudo; `select` troca a aba do agente; `close` fecha a que você abriu.

## 6. Rede instável da extensão

O service worker do Chrome cai quando o Chrome reinicia ou recarrega a extensão. O hub agora
**repete a requisição uma vez** depois de reencontrar a extensão (até 8 s). Se ainda falhar, veja
`browser_status` e confirme que o Chrome está de pé.

## 7. Modos de página (Facebook/Meta)

Algumas URLs caem na casca pública ("Entrar / Ver mais no Facebook") mesmo com sessão ativa. O caminho
confiável é entrar pelo gerenciador (`facebook.com/pages/?category=your_pages` → abrir a Página) e
navegar dentro do contexto de admin; URLs `sk=directory_*` funcionam a partir dali.

## 8. Sem chave do Jev

`jev_task`, `jev_find` e `jev_check` dependem de chave (`front/.env` ou opções da extensão). Sem ela
o agente decide pela árvore de acessibilidade e usa as ferramentas de driver acima. Não peça a chave
ao site: ela nunca vai para a página.

## 9. Limites do projeto continuam valendo

Sem automação de engajamento (curtir/comentar/seguir/rolar feed em volume), pausa fixa em terceiros,
nada de publicar/comprar/apagar sem confirmação humana. Ver `AGENTS.md` na raiz do lab.
