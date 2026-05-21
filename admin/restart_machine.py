#!/usr/bin/env python3
"""
Restart a Fly machine.

Usage:
    python3 admin/restart_machine.py <app_name> <machine_id>

Example:
    python3 admin/restart_machine.py reins-ykrjigoo 080de37f66d178
"""

import sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])

from lib import fly as fly_client


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    app_name, machine_id = sys.argv[1], sys.argv[2]
    print(f'Restarting {app_name}/{machine_id}...')
    fly_client.restart_machine(app_name, machine_id)
    print('Done. Machine restart initiated.')


if __name__ == '__main__':
    main()
