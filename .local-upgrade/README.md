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

# Porte para OpenMausBot v0.1.123 (22/10/2026, noite)

Base: tag v0.1.123 (40deb33ce). Origem: `local/v0.1.122-mod` (porte da 0.1.121) + correção do Today (#3322) + a rodada 2 de hoje, aplicados por cherry-pick sem conflito de texto.

## O que a rodada 2 acrescentou
- **Reservas 8** (`server/routes/bot-patch.ts`, `MAX_FALLBACK`): o limite upstream era 5; a frota usa 8.
- **Gatilho de app com exclusão** (`notSubject`, lista de palavras que o título não pode ter; palavra inteira, evento sem título passa): `shared/app-triggers.ts`, `server/app-events.ts`, `server/app-triggers.ts`, `server/app-trigger-requests.ts`.
- **Ponte de troca de conta**: motivo de cada repasse pulado no `server.log` (`[account-handoff] skipped … reason=`), e conversa com anexo repassa o texto sem o anexo (`accountHandoffCheckpoint`).
- **Metade estável do prompt**: `automation-reply` passou para a metade volátil e a regra do webhook fica em todas as voltas de uma conversa que já teve webhook; log `[prompt-cache] stable half changed … sections=` diz quais seções mudaram.

## Tirado do porte / conferido contra a 0.1.123
- Today: a página foi trocada pelo brief (#3314), mas `server/today.ts` (`needsYouNow`) continua e alimenta o "Needs you" do brief; a correção #3322 continua valendo (testes de Today e o e2e `late-question-today` passam).
- #3328 (parada em tool longa aos 20 min) é do upstream: nada local a tirar.
- Catálogo: 55 ferramentas upstream idênticas + 5 locais (`delete_table`, `execute_data`, `list_tables`, `query_data`, `routine_no_update`).

## Verificação (1 worker, heap 1800 MB; UI com 4096 MB)
- Vitest focado: 42 arquivos, 721 passaram, 1 pulado, 0 falhas (`verify-123.py`).
- `tsc -p tsconfig.server.build.json`, `scripts/bundle-server.mjs`, `smoke-packaged-server.mjs` e `vite build`: ok.
- Não rodados: lint, typecheck global, suíte completa, Electron.
