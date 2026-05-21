#!/usr/bin/env python3
"""
List all agents joined with their live Fly deployment state.

Usage:
    python3 admin/list_agents.py [--fly]

Options:
    --fly   Also fetch live machine state from Fly API (slower, shows started/stopped)
"""

import sys
import argparse

sys.path.insert(0, __file__.rsplit('/', 1)[0])

from lib.reins import list_agents
from lib import fly as fly_client


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fly', action='store_true', help='Fetch live machine state from Fly API')
    args = parser.parse_args()

    agents = list_agents()
    if not agents:
        print('No agents found.')
        return

    # Pre-fetch live machine state if requested
    machine_states: dict[str, str] = {}
    if args.fly:
        print('Fetching live machine state from Fly...')
        for row in agents:
            app = row.get('fly_app_name')
            mid = row.get('fly_machine_id')
            if app and mid:
                try:
                    m = fly_client.get_machine(app, mid)
                    machine_states[mid] = m.get('state', '?')
                except Exception:
                    machine_states[mid] = 'error'

    fmt = '{:<22}  {:<30}  {:<10}  {:<12}  {:<16}  {:<14}  {}'
    print(fmt.format('AGENT_ID', 'NAME', 'RUNTIME', 'DEPLOY_STATUS', 'FLY_APP', 'MACHINE_ID', 'FLY_STATE' if args.fly else ''))
    print('-' * 130)

    for row in agents:
        mid = row.get('fly_machine_id') or ''
        fly_state = machine_states.get(mid, '') if args.fly else ''
        print(fmt.format(
            (row.get('id') or '')[:22],
            (row.get('name') or '')[:30],
            row.get('runtime') or '',
            row.get('deployment_status') or '',
            (row.get('fly_app_name') or '')[:16],
            mid[:14],
            fly_state,
        ))

    print(f'\n{len(agents)} agent(s)')


if __name__ == '__main__':
    main()
