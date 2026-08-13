#!/usr/bin/env python3
"""
Redeploy every deployed agent so it picks up the renamed MCP server.

MCP_CONFIG is baked into a Fly machine's env at deploy time, so an agent
deployed before the reins -> helm rename keeps sending the old tool names until
it is redeployed. The backend still accepts those names (see LEGACY_TOOL_ALIASES
in shared/src/mcp-naming.ts), so this is a catch-up, not an outage fix — agents
work either way, they just see the old prefix until rolled.

Order matters: deploy agenthelm-core FIRST, then rebuild both agent images, then
run this. Running it before the images are rebuilt still works but the agents
will not pick up the updated bundled skills and BOOTSTRAP.md.

Usage:
    python3 admin/redeploy_all_for_mcp_rename.py [--dry-run] [--runtime openclaw|hermes]

Options:
    --dry-run        List affected agents without redeploying
    --runtime NAME   Only redeploy agents on this runtime
    --limit N        Redeploy at most N agents (useful for a canary batch)
"""

import sys
import argparse

sys.path.insert(0, __file__.rsplit('/', 1)[0])

from lib import reins as reins_client


# Agents in these states have no live machine to update.
SKIP_STATUSES = {'destroyed', 'error', 'stopped'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true', help='List affected agents without redeploying')
    parser.add_argument('--runtime', choices=['openclaw', 'hermes'], help='Only redeploy this runtime')
    parser.add_argument('--limit', type=int, help='Redeploy at most N agents')
    args = parser.parse_args()

    print('Fetching agents from Reins API...')
    agents = reins_client.list_agents()

    targets = [
        a for a in agents
        if (a.get('deployment_status') or '') not in SKIP_STATUSES
        and (args.runtime is None or (a.get('runtime') or 'openclaw') == args.runtime)
    ]

    skipped = len(agents) - len(targets)

    if args.limit is not None and len(targets) > args.limit:
        print(f'Limiting to first {args.limit} of {len(targets)} eligible agent(s).')
        targets = targets[:args.limit]

    if not targets:
        print('No agents to redeploy.')
        return

    print(f'\nFound {len(targets)} agent(s) to redeploy ({skipped} skipped as not deployed):\n')
    fmt = '{:<22}  {:<30}  {:<10}  {}'
    print(fmt.format('AGENT_ID', 'NAME', 'RUNTIME', 'STATUS'))
    print('-' * 80)
    for a in targets:
        print(fmt.format(
            (a.get('id') or '')[:22],
            (a.get('name') or '')[:30],
            (a.get('runtime') or 'openclaw')[:10],
            a.get('deployment_status') or '',
        ))

    if args.dry_run:
        print('\nDry run — no changes made.')
        return

    confirm = input(f'\nRedeploy {len(targets)} agent(s)? This restarts each machine. [y/N] ').strip().lower()
    if confirm != 'y':
        print('Aborted.')
        sys.exit(0)

    print()
    ok = 0
    failed = []
    for a in targets:
        agent_id = a.get('id') or ''
        name = a.get('name') or agent_id
        print(f'  Redeploying {name} ({agent_id[:12]})...', end=' ', flush=True)
        try:
            # No model overrides: redeploy rebuilds MCP_CONFIG from current
            # config, which is the whole point of this pass.
            reins_client.redeploy_agent(agent_id)
            print('OK')
            ok += 1
        except Exception as e:
            print(f'FAILED: {e}')
            failed.append((name, str(e)))

    print(f'\nDone: {ok} succeeded, {len(failed)} failed.')
    if failed:
        print('\nFailed agents:')
        for name, err in failed:
            print(f'  {name}: {err}')
        print('\nRe-running is safe — already-updated agents simply redeploy again.')
        sys.exit(1)


if __name__ == '__main__':
    main()
