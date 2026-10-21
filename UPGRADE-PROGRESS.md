# Progresso do porte 0.1.119 -> 0.1.120
- 21/10/2026 01:50 BRT: plano gravado em .local-upgrade/PLAN.md; aplicando patch v2.
- 21/10/2026 01:50 BRT: patch v2 aplicado sem conflitos (3-way); instalando deps com lockfile.
- 21/10/2026 01:51 BRT: deps instaladas; rodando verify-120.py (goldens, focados, typecheck, bundle, smoke, UI).
- 21/10/2026 02:00 BRT: 1ª rodada: 26 falhas em agents-bridge(.test/-wire) — goldens bridged/orçamento novos da 120 + ranking BM25 (delete_table). Corrigido (goldens regenerados, BUDGET_BASELINE +432, teste de ranking isola upstream). Rerodando tudo.
- 21/10/2026 02:10 BRT: servidor verde (35 arquivos/615 testes, typecheck, bundle, smoke). Build UI estourou 1800MB; refazendo com 4096MB só para vite.
- 21/10/2026 02:11 BRT: UI ok (4096MB), patch reproduzível e README gerados; abrindo PR no fork.
- 21/10/2026 02:16 BRT: PR aberto no fork; pronto.
