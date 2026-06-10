#!/usr/bin/env python3
"""
Update all MiniMax agents to a new model name and redeploy them.

Finds every deployed agent with model_provider='minimax' whose model_name
does not already match the target, then calls the redeploy endpoint with
the new model name so the Fly machine env vars are updated in-place.

Usage:
    python3 admin/update_minimax_model.py [--model MiniMax-M3] [--dry-run]

Options:
    --model MODEL   Target model name (default: MiniMax-M3)
    --dry-run       List affected agents without redeploying
"""

import sys
import argparse

sys.path.insert(0, __file__.rsplit('/', 1)[0])

from lib import reins as reins_client


DEFAULT_MODEL = 'MiniMax-M3'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default=DEFAULT_MODEL, help=f'Target model name (default: {DEFAULT_MODEL})')
    parser.add_argument('--dry-run', action='store_true', help='List affected agents without redeploying')
    args = parser.parse_args()

    print('Fetching agents from Reins API...')
    agents = reins_client.list_agents()

    minimax_agents = [
        a for a in agents
        if a.get('model_provider') == 'minimax' and a.get('model_name') != args.model
    ]

    if not minimax_agents:
        print(f'No MiniMax agents need updating (all already on {args.model} or none found).')
        return

    print(f'\nFound {len(minimax_agents)} agent(s) to update → {args.model}:\n')
    fmt = '{:<22}  {:<30}  {:<16}  {}'
    print(fmt.format('AGENT_ID', 'NAME', 'CURRENT_MODEL', 'STATUS'))
    print('-' * 90)
    for a in minimax_agents:
        print(fmt.format(
            (a.get('id') or '')[:22],
            (a.get('name') or '')[:30],
            (a.get('model_name') or '')[:16],
            a.get('deployment_status') or '',
        ))

    if args.dry_run:
        print('\nDry run — no changes made.')
        return

    confirm = input(f'\nRedeploy {len(minimax_agents)} agent(s) with model={args.model}? [y/N] ').strip().lower()
    if confirm != 'y':
        print('Aborted.')
        sys.exit(0)

    print()
    ok = 0
    failed = []
    for a in minimax_agents:
        agent_id = a.get('id') or ''
        name = a.get('name') or agent_id
        print(f'  Redeploying {name} ({agent_id[:12]})...', end=' ', flush=True)
        try:
            reins_client.redeploy_agent(agent_id, model_name=args.model)
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
        sys.exit(1)


if __name__ == '__main__':
    main()
