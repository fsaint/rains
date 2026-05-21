"""
Reins backend admin API client.
Authenticates via Authorization: Bearer <REINS_ADMIN_API_KEY>.
"""

import json
import urllib.request
import urllib.error
from typing import Any

from . import config as cfg


def _request(method: str, path: str, body: Any = None) -> Any:
    url = cfg.REINS_ADMIN_URL() + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={
            'Authorization': f'Bearer {cfg.REINS_ADMIN_API_KEY()}',
            'Content-Type': 'application/json',
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        body_text = e.read().decode(errors='replace')
        raise RuntimeError(f'Reins API {e.code} {method} {path}: {body_text}') from e


def list_users() -> list[dict]:
    result = _request('GET', '/api/admin/users')
    return (result or {}).get('data', [])


def list_agents() -> list[dict]:
    result = _request('GET', '/api/admin/agents')
    return (result or {}).get('data', [])
