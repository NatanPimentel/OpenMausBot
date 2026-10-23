# Porte das adaptações locais 0.1.121 → OpenMausBot v0.1.122

Base: tag v0.1.122 (23ed2ef13). Origem: commit d1664751c (ramo local/v0.1.121-mod), aplicado por cherry-pick 3-way.
Nada em My Cloud (`server/cloud*`, config, consentimento) foi tocado; o envio automático é desligado só na configuração local (`auto: false`).

## Arquivos
- `verify-122.py`, `verification-results-122.json`, `catalog-compatibility-122.json`, `logs/` — verificação desta rodada.
- O patch reproduzível (`122-production-port.patch`) fica em `/home/natan/artefatos/gabinete/2026-10-22-openmausbot-0122/`.

## Inventário funcional (tudo do v2 preservado)
- **Failover de contas Claude**: `limit-failover.ts`, `limit-reset*`, `claude-auth-recovery.ts`, escolha de backup e herança de effort
  (`OMB_CLAUDE_ACCOUNT_FAILOVER`) em `server/index.ts`.
- **Handoff AI-Memory**: `ai-memory-handoff.ts` + compactação com `accountHandoff` (`OMB_AI_MEMORY_HANDOFF_COMMAND`).
- **OpenBot Shared Data**: `server/openbot-data/*` (host, store, child, SQL, protocolo), ferramentas `list_tables`, `query_data`,
  `execute_data`, `delete_table` (`agents-openbot-data.ts`), rota interna, `OMB_OPENBOT_DATA_PATH`, bundle do worker.
- **routine_no_update**: ferramenta, rota interna, `noUpdate` na execução (`shared/routines.ts`, `routines.ts`), sem não lido/aviso;
  webhook arquivado e lido; na lista quente da ponte.
- **Leitura/notificações**: abrir/trocar conversa lê os avisos do thread e emite `notifications.read` (`routes/*`, `shared/wire.ts`);
  UI equivalente em `src/state/store.tsx` (trata o frame e avança a versão periférica `notifications`).
- **Runtimes externos silenciosos**: repasse registra "X replied" sem marcar não lido.

## Resolvido nesta porta (diferenças com a 121)
1. Conflitos: `agents-call.ts` (nova `publish_page` + ferramentas de dados), `server/index.ts` (rota de páginas publicadas + rotas internas de dados e `routine-no-update`),
   goldens `profiles`/`bridged.*` (regenerados) e os dois `BUDGET_BASELINE` (upstream + 3265 B no catálogo, + 432 B na ponte).
2. A ponte agora tem 15 ferramentas quentes (publish_page upstream + routine_no_update local): teto do teste 14 → 15.
3. O poll de runtime externo voltava a marcar a conversa fixada como não lida via `markTaskContextExternallyUpdated`; ganhou o parâmetro `unread` e o caminho `resultsPolled` o desliga.
4. Catálogo: 55 ferramentas upstream idênticas; adicionadas só `delete_table`, `execute_data`, `list_tables`, `query_data`, `routine_no_update`.

## Verificação (1 worker, heap 1800 MB)
- Vitest focado: 35 arquivos, 621 passaram, 1 skipped, 0 falhas.
- `tsc -p tsconfig.server.build.json`, `scripts/bundle-server.mjs`, `smoke-packaged-server.mjs`: ok.
- Build UI (vite): ok com heap 4096 MB. O bundle contém `notifications.read`.
- Não rodados: lint, typecheck global, suíte completa, Electron. GPU é aplicado no app.asar novo na instalação.

---

# Página "Precisa de você" (23/10/2026)

Item fixo no topo da barra lateral, acima dos times, com o número de pendências; abre uma página própria (`activeView: "needs-you"`).
Uma linha por assunto: cartões de pergunta de todos os bots, cópias do pedir-natan (rodapé `pedido <id>`), pedidos ainda sem cartão,
aprovações abertas, trabalho parado em pergunta e problemas de configuração do Needs you do Hoje.

- Agrupamento: porte de `pergunta_registro.py` (`limpar`, `tokens`, `pesos`, `carregar_idf`, `similaridade`) em `server/question-subjects.ts`,
  idêntico ao Python nos 78 casos do registro de 23/10 (3003 pares). Mesmo assunto: mesmo pedido, similaridade ≥ 0,45 (portão), ou ≥ 0,35
  quando é o mesmo bot (limiar do `grupos`).
- Responder: a página responde cada cartão do grupo por `/api/threads/:id/respond` (o caminho do botão do cartão); o pedido com cartão
  recebe a resposta pela ponte do pedir-natan (colher), o pedido sem cartão por `pedir-natan responder` (`POST /api/needs-you/pedidos`).
- Nada sai por tempo. Sai quando respondido, ou quando o pedido foi resolvido (`pedir-natan resolver`) ou o cartão fechado pela CLI do
  registro com texto que não é de duplicata; aparece em "Resolvidas hoje" com a linha de como.
- Número único: `GET /api/needs-you?since=<ms>` → `count`. A barra, a página e o ícone do app (`setUnreadCount`) usam esse número.

## Montar o pacote 0.1.125 (quem instala é o Dr. Eggbot)
    node scripts/bundle-server.mjs && NODE_OPTIONS=--max-old-space-size=4096 node node_modules/vite/bin/vite.js build
    rsync -a --delete dist-server/ ~/.local/share/openmausbot-mod/0.1.125/server/
    rsync -a --delete dist/ ~/.local/share/openmausbot-mod/0.1.125/ui/
O `app.asar.patched` não muda. Depois: `sudo -n ~/.local/share/openmausbot-mod/instalar-servidor.sh` e um reinício.
