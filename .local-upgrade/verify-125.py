from pathlib import Path
import json, os, subprocess, time, sys
root = Path(__file__).parent
repo = root.parent
node = '/home/natan/.local/share/ecosystem-runtime/node-v26.7.0-linux-x64/bin/node'
env = dict(os.environ)
env['PATH'] = str(Path(node).parent) + ':/home/natan/.local/bin:/usr/bin:/bin'
env['NODE_OPTIONS'] = '--max-old-space-size=1800'
results_file = root / 'verification-results-125.json'
results = json.loads(results_file.read_text()) if results_file.exists() else {}
only = set(sys.argv[1:])

def run(name, args, extra=None):
    if only and name not in only: return
    started = time.monotonic()
    with (root / 'logs' / (name + '.log')).open('w') as log:
        r = subprocess.run(args, cwd=repo, env={**env, **(extra or {})}, stdout=log, stderr=subprocess.STDOUT)
    results[name] = {'exit': r.returncode, 'seconds': round(time.monotonic() - started, 2)}
    results_file.write_text(json.dumps(results, indent=2) + '\n')
    print(name, results[name], flush=True)
    if r.returncode:
        print('\n'.join((root / 'logs' / (name + '.log')).read_text().splitlines()[-45:]))
        raise SystemExit(r.returncode)

(root / 'logs').mkdir(exist_ok=True)
vitest = [node, 'node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1']
run('catalog-goldens', vitest + ['server/drivers/agents-catalog-wire.test.ts', 'server/drivers/agents-bridge-wire.test.ts'], {'UPDATE_AGENTS_CATALOG_GOLDENS': '1'})
if not only or 'catalog-goldens' in only:
    path = 'server/drivers/agents-catalog-goldens/full.tools-list.json'
    before = json.loads(subprocess.check_output(['git', 'show', 'v0.1.125:' + path], cwd=repo))['tools']
    after = json.loads((repo / path).read_text())['tools']
    old = {t['name']: t for t in before}; new = {t['name']: t for t in after}
    assert not old.keys() - new.keys(), 'An upstream tool was removed'
    assert all(new[n] == t for n, t in old.items()), 'An upstream tool definition changed'
    added = sorted(new.keys() - old.keys())
    assert added == ['delete_table', 'execute_data', 'list_tables', 'query_data', 'routine_no_update'], added
    (root / 'catalog-compatibility-125.json').write_text(json.dumps({'added_tools': added, 'upstream_tools_preserved': len(old)}, indent=2) + '\n')
    print('catalog ok', added, len(old))
TESTS = sys.argv[0] and [
    'server/openbot-routine-no-update.test.ts', 'server/routine-no-update.e2e.test.ts',
    'server/external-runtime.e2e.test.ts', 'server/external-runtime-busy.e2e.test.ts', 'server/external-runtime-timeout.e2e.test.ts',
    'server/message-db.test.ts', 'server/routes/notifications.test.ts', 'server/routines.test.ts',
    'server/routine-results.e2e.test.ts', 'server/routine-run-broadcast.e2e.test.ts', 'server/routine-delegation.e2e.test.ts',
    'server/notification-wiring.test.ts', 'server/notification-routing.e2e.test.ts', 'server/runtime-roots.e2e.test.ts',
    'server/drivers/agents-catalog-wire.test.ts', 'server/agents-bridge.e2e.test.ts', 'server/webhook-room-post.e2e.test.ts',
    'server/ai-memory-handoff.test.ts', 'server/agent-tool-policy.test.ts', 'server/drivers/agents-bridge.test.ts',
    'server/drivers/claude-auth-recovery.test.ts', 'server/limit-failover.test.ts', 'server/limit-reset-requests.test.ts',
    'server/limit-reset.e2e.test.ts', 'server/openbot-data/host.test.ts', 'server/openbot-data/package.test.ts',
    'server/openbot-data/process.test.ts', 'server/openbot-data/store.test.ts',
    'server/limit-resets.test.ts', 'server/routines-limit-reset.test.ts', 'server/notify.test.ts', 'server/external-runtime.test.ts',
    'server/drivers/agents-bridge-chat.test.ts', 'server/drivers/agents-bridge-wire.test.ts', 'server/routine-execution.test.ts',
    # rodada 2: reservas 8, filtro notSubject, ponte (motivos e anexo), prompt estavel, Today
    'server/routes/bot-patch.test.ts', 'server/app-triggers.test.ts', 'server/app-events.e2e.test.ts', 'server/limit-reset.e2e.test.ts',
    'server/system-prompt.test.ts', 'server/automation-reports.e2e.test.ts', 'server/today.test.ts', 'server/late-question-today.e2e.test.ts',
]
run('focused-tests', vitest + TESTS)
run('server-typecheck-build', [node, 'node_modules/typescript/lib/tsc.js', '-p', 'tsconfig.server.build.json'])
run('server-bundle', [node, 'scripts/bundle-server.mjs'])
run('packaged-server-smoke', [node, 'scripts/smoke-packaged-server.mjs'])
run('ui-build', [node, 'node_modules/vite/bin/vite.js', 'build'], {'NODE_OPTIONS': '--max-old-space-size=4096'})
print('done')
