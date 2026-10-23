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
