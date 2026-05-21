#!/usr/bin/env python3
"""
Run a read-only command on a Fly machine via the Machines API exec endpoint.
Does not require WireGuard. Useful when fly ssh console is unavailable.

Usage:
    python3 admin/exec_machine.py <app_name> <machine_id> -- <cmd> [args...]

Examples:
    python3 admin/exec_machine.py agenthelm-core 6e820d63cee048 -- ls /tmp
    python3 admin/exec_machine.py reins-ykrjigoo 080de37f66d178 -- sh -c "ps aux | head -5"
"""

import sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])

from lib import fly as fly_client


def main():
    if '--' not in sys.argv:
        print(__doc__)
        sys.exit(1)

    sep = sys.argv.index('--')
    positional = sys.argv[1:sep]
    command = sys.argv[sep + 1:]

    if len(positional) < 2 or not command:
        print(__doc__)
        sys.exit(1)

    app_name, machine_id = positional[0], positional[1]

    print(f'Exec on {app_name}/{machine_id}: {command}')
    result = fly_client.exec_machine(app_name, machine_id, command)

    stdout = result.get('stdout', '')
    stderr = result.get('stderr', '')
    exit_code = result.get('exit_code', 0)

    if stdout:
        print(stdout, end='')
    if stderr:
        print(stderr, end='', file=sys.stderr)
    sys.exit(exit_code)


if __name__ == '__main__':
    main()
