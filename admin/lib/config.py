"""Loads admin credentials from admin/.env.admin."""

import os
from pathlib import Path


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                key, _, value = line.partition('=')
                os.environ.setdefault(key.strip(), value.strip())


_env_file = Path(__file__).parent.parent / '.env.admin'
_load_env_file(_env_file)


def require(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        raise RuntimeError(
            f'{key} is not set. Add it to admin/.env.admin (see admin/.env.admin.example).'
        )
    return val


FLY_ADMIN_TOKEN = lambda: require('FLY_ADMIN_TOKEN')
REINS_ADMIN_URL = lambda: require('REINS_ADMIN_URL')
REINS_ADMIN_API_KEY = lambda: require('REINS_ADMIN_API_KEY')
