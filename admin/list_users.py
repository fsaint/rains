#!/usr/bin/env python3
"""List all platform users via the Reins admin API."""

import sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])

from lib.reins import list_users

users = list_users()
if not users:
    print('No users found.')
    sys.exit(0)

fmt = '{:<36}  {:<30}  {:<10}  {:<10}  {}'
print(fmt.format('ID', 'EMAIL', 'ROLE', 'STATUS', 'CREATED'))
print('-' * 110)
for u in users:
    print(fmt.format(
        u.get('id', ''),
        u.get('email', ''),
        u.get('role', ''),
        u.get('status', ''),
        (u.get('created_at') or '')[:10],
    ))
print(f'\n{len(users)} user(s)')
