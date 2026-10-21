# Porte das adaptações locais 0.1.119 → OpenMausBot v0.1.120

Base: `origin/main` = tag v0.1.120 (c192de3c2). Origem: `119-production-port-v2.patch` (sobre 353a77eb).
O patch aplicou por 3-way sem conflito; só `server/index.ts` exigiu fallback (hunks já casaram). Nada em My Cloud
(`server/cloud*`, config, consentimento) foi tocado; a sincronização automática da 120 continua como o upstream define.

## Arquivos
- `120-production-port.patch` — diff completo sobre v0.1.120 (`git apply` limpo, conferido em worktree limpo).
- `result-120.json`, `verification-results-120.json`, `verify-120.py`, `logs/` — verificação reexecutada nesta rodada.
- `bundle/server` (dist-server) e `bundle/ui` (dist) — bundles compilados; `bundle-sha256.txt`. Ignorados pelo git.
- `PLAN.md`, `../UPGRADE-PROGRESS.md` — plano e checkpoints (hora de Brasília).

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

## Resolvido nesta porta (diferenças com a 120)
1. A 120 trouxe `agents-bridge-wire.test.ts` + goldens `bridged.*`: regenerados e `BUDGET_BASELINE` +432 B (tamanho de `routine_no_update`);
   a lista quente do teste ganhou `routine_no_update`.
2. `agents-bridge.test.ts`: as ferramentas de dados (`delete_table`) superavam, no BM25, duas consultas upstream
   ("delete a teammate", "pause or delete one of my routines"). Falha latente que o 119 nunca rodou. O teste de ranking agora usa o catálogo
   upstream; novos testes provam que a ferramenta upstream continua entre os resultados e que as de dados são achadas.
3. Catálogo: 50 ferramentas upstream idênticas; adicionadas só `delete_table`, `execute_data`, `list_tables`, `query_data`, `routine_no_update`.

## Verificação (fixtures isoladas, 1 worker, heap 1800 MB)
- Goldens do catálogo/bridge regenerados e comparados com `origin/main`.
- Vitest focado: 35 arquivos, 615 passaram, 2 skipped, 0 falhas (inclui failover, handoff, openbot-data, routine-no-update, notificações, runtimes externos).
- `tsc -p tsconfig.server.build.json`, `scripts/bundle-server.mjs`, `smoke-packaged-server.mjs`: ok.
- Build UI (vite): ok; precisou de heap 4096 MB (1800 MB estoura). O bundle contém `notifications.read`.
- Não rodados: lint, typecheck global, suíte completa, app vivo, Electron. GPU é aplicado pelo coordenador no app.asar novo.

## Ativação (coordenador)
`bundle/server` substitui o servidor empacotado; a UI vem de `bundle/ui` (nome do arquivo difere do build oficial).
Backup, GPU e smoke read-only ficam com o coordenador.
