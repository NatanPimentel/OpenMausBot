# Plano mínimo (21/10/2026)
1. `git apply --3way` do 119-production-port-v2.patch sobre v0.1.120; resolver conflitos (hoje só server/index.ts) preservando o upstream.
2. Conferir semântica nos arquivos auto-mesclados; regenerar goldens do catálogo e provar que só 5 ferramentas locais foram adicionadas.
3. Testes focados (1 worker), typecheck do servidor, bundle, smoke empacotado, build da UI.
4. Gravar logs/JSON/patch/README em .local-upgrade/, progresso em UPGRADE-PROGRESS.md, abrir PR no fork.
Sem features novas; My Cloud não é habilitado nem alterado.
