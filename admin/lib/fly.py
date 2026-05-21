"""
Fly Machines API client for admin tools.

SAFETY: This client enforces an allowlist of permitted HTTP method + path patterns.
DELETE is intentionally absent. The admin lane cannot destroy apps or machines in
production — use the Reins dashboard (production-runtime lane) for that.

Any future need to add destructive capabilities requires:
  1. Editing ALLOWED_PATTERNS here in a reviewed PR, AND
  2. Minting a wider FLY_ADMIN_TOKEN (see docs/ops/ADMIN_TOOLS.md).
"""

import re
import json
import urllib.request
import urllib.error
from typing import Any

from . import config as cfg

FLY_API = 'https://api.machines.dev/v1'
FLY_GRAPHQL = 'https://api.fly.io/graphql'

# Allowlisted (method, path-regex) pairs. No DELETE anywhere.
ALLOWED_PATTERNS: list[tuple[str, re.Pattern]] = [
    ('GET',  re.compile(r'^/v1/apps$')),
    ('GET',  re.compile(r'^/v1/apps/[^/]+$')),
    ('GET',  re.compile(r'^/v1/apps/[^/]+/machines$')),
    ('GET',  re.compile(r'^/v1/apps/[^/]+/machines/[^/]+$')),
    ('GET',  re.compile(r'^/v1/apps/[^/]+/volumes$')),
    ('POST', re.compile(r'^/v1/apps$')),                              # create app (recover_agent)
    ('POST', re.compile(r'^/v1/apps/[^/]+/machines$')),              # create machine
    ('POST', re.compile(r'^/v1/apps/[^/]+/volumes$')),               # create volume
    ('POST', re.compile(r'^/v1/apps/[^/]+/machines/[^/]+/exec$')),   # diagnostic exec
    ('POST', re.compile(r'^/v1/apps/[^/]+/machines/[^/]+/restart$')), # restart
]


def _check_allowed(method: str, path: str) -> None:
    method = method.upper()
    for allowed_method, pattern in ALLOWED_PATTERNS:
        if method == allowed_method and pattern.match(path):
            return
    raise PermissionError(
        f'admin tools may not call {method} {path}. '
        'Edit admin/lib/fly.py ALLOWED_PATTERNS to add new capabilities (requires PR review).'
    )


def _request(method: str, path: str, body: Any = None, token: str | None = None) -> Any:
    _check_allowed(method, path)
    token = token or cfg.FLY_ADMIN_TOKEN()
    url = FLY_API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        body_text = e.read().decode(errors='replace')
        raise RuntimeError(f'Fly API {e.code} {method} {path}: {body_text}') from e


def graphql(query: str, variables: dict | None = None, token: str | None = None) -> Any:
    token = token or cfg.FLY_ADMIN_TOKEN()
    payload = json.dumps({'query': query, 'variables': variables or {}}).encode()
    req = urllib.request.Request(
        FLY_GRAPHQL, data=payload, method='POST',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
        },
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


# ---- Public helpers ---------------------------------------------------------

def list_apps(org: str | None = None) -> list[dict]:
    path = '/v1/apps'
    if org:
        path += f'?org_slug={org}'
    result = _request('GET', path)
    return result.get('apps', []) if isinstance(result, dict) else (result or [])


def get_app(app_name: str) -> dict:
    return _request('GET', f'/v1/apps/{app_name}') or {}


def list_machines(app_name: str) -> list[dict]:
    result = _request('GET', f'/v1/apps/{app_name}/machines')
    return result if isinstance(result, list) else []


def get_machine(app_name: str, machine_id: str) -> dict:
    return _request('GET', f'/v1/apps/{app_name}/machines/{machine_id}') or {}


def exec_machine(app_name: str, machine_id: str, command: list[str], timeout: int = 30) -> dict:
    """Run a command on a machine via the Fly exec endpoint. Returns stdout/stderr/exit_code."""
    return _request(
        'POST', f'/v1/apps/{app_name}/machines/{machine_id}/exec',
        body={'command': command, 'timeout': timeout},
    ) or {}


def restart_machine(app_name: str, machine_id: str) -> None:
    _request('POST', f'/v1/apps/{app_name}/machines/{machine_id}/restart')


def create_app(app_name: str, org_slug: str) -> dict:
    return _request('POST', '/v1/apps', body={'app_name': app_name, 'org_slug': org_slug}) or {}


def create_volume(app_name: str, region: str, size_gb: int = 1) -> dict:
    return _request(
        'POST', f'/v1/apps/{app_name}/volumes',
        body={'name': 'agent_state', 'region': region, 'size_gb': size_gb, 'encrypted': False},
    ) or {}


def create_machine(app_name: str, name: str, region: str, config: dict) -> dict:
    return _request(
        'POST', f'/v1/apps/{app_name}/machines',
        body={'name': name, 'region': region, 'config': config},
    ) or {}


def allocate_ips(app_name: str, token: str | None = None) -> None:
    mutation = '''mutation($input: AllocateIPAddressInput!) {
      allocateIpAddress(input: $input) { ipAddress { id } }
    }'''
    for ip_type in ('v6', 'shared_v4'):
        try:
            graphql(mutation, {'input': {'appId': app_name, 'type': ip_type}}, token=token)
        except Exception as e:
            print(f'  IP alloc {ip_type} failed (non-fatal): {e}')
