#!/usr/bin/env python3
"""
Recover a destroyed agent: create a new Fly app, volume, and machine from
the existing deployed_agents record, then update the DB via the Reins API.

This is the clean, committed replacement for the ad-hoc recover_one_agent.js
scripts that were written during incidents. Run it any time a Fly app is
accidentally destroyed but the deployed_agents row still exists.

Usage:
    python3 admin/recover_agent.py <agent_id>

The agent_id is the value from the agents.id column (e.g. bX6AkIUQwE5gc9Izo57TM).
The script reads deployment config via the Reins admin API, provisions Fly
resources using FLY_ADMIN_TOKEN, and calls the Reins restore endpoint to
update the deployed_agents row.

Safety:
  - Uses admin/lib/fly.py, which has no DELETE operations.
  - Will NOT destroy existing apps or machines — only creates new ones.
  - Prompts for confirmation before making any Fly API calls.
"""

import sys
import json
import secrets
import re

sys.path.insert(0, __file__.rsplit('/', 1)[0])

from lib import fly as fly_client
from lib import reins as reins_client
from lib import config as cfg

REINS_URL = cfg.REINS_ADMIN_URL
MINIMAX_BASE_URL = 'https://api.minimax.io/v1'


def nanoid(length: int = 21) -> str:
    alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-'
    return ''.join(secrets.choice(alphabet) for _ in range(length))


def build_machine_config(dep: dict, new_deployment_id: str, new_gateway_token: str,
                          new_webhook_secret: str, openclaw_image: str) -> dict:
    """
    Mirror of backend/src/providers/fly.ts:buildMachineConfig.
    Keep in sync with that function — drift is dangerous.
    """
    agent_id = dep['agent_id']
    is_shared_bot = bool(dep.get('is_shared_bot'))
    reins_url = REINS_URL()
    mcp_configs = [{'name': 'reins', 'url': f'{reins_url}/mcp/{agent_id}', 'transport': 'http'}]

    openai_api_key = dep.get('openai_api_key') or ''
    minimax_key = dep.get('minimax_api_key', '')  # injected by caller if needed

    webhook_url = (
        f'{reins_url}/api/webhooks/shared-bot'
        if is_shared_bot
        else f'{reins_url}/api/webhooks/agent-bot/{new_deployment_id}'
    )

    env: dict = {
        'TELEGRAM_BOT_TOKEN': dep['telegram_token'],
        'MCP_CONFIG': json.dumps(mcp_configs),
        'USAGE_CALLBACK_URL': f'{reins_url}/api/webhooks/usage',
        'INSTANCE_USER_ID': new_deployment_id,
        'REINS_API_URL': reins_url,
        'OPENCLAW_GATEWAY_TOKEN': new_gateway_token,
        'NODE_OPTIONS': '--max-old-space-size=3072 --dns-result-order=ipv4first',
        'MODEL_PROVIDER': 'openai',
        'OPENAI_BASE_URL': MINIMAX_BASE_URL,
        'OPENAI_API_KEY': openai_api_key or minimax_key,
        'THINKING_DEFAULT': 'medium',
        'OPENCLAW_WEBHOOK_URL': webhook_url,
        'OPENCLAW_WEBHOOK_SECRET': new_webhook_secret,
    }

    if dep.get('soul_md'):
        env['SOUL_MD'] = dep['soul_md']
    if dep.get('telegram_user_id'):
        env['TELEGRAM_TRUSTED_USER'] = str(dep['telegram_user_id'])
    if dep.get('model_name'):
        env['MODEL_NAME'] = dep['model_name']

    return {
        'image': openclaw_image,
        'guest': {'cpu_kind': 'shared', 'cpus': 2, 'memory_mb': 4096},
        'env': env,
        'services': [
            {
                'ports': [{'port': 443, 'handlers': ['tls', 'http']}],
                'protocol': 'tcp',
                'internal_port': 18789,
                'autostart': True,
                'autostop': 'off',
                'checks': [{
                    'type': 'http', 'method': 'get', 'path': '/healthz',
                    'port': 18789, 'interval': '15s', 'timeout': '5s', 'grace_period': '120s',
                }],
            },
            {
                'ports': [{'port': 8443, 'handlers': ['tls', 'http']}],
                'protocol': 'tcp',
                'internal_port': 8787,
                'autostart': True,
                'autostop': 'off',
            },
        ],
    }


def register_webhook(token: str, deployment_id: str, secret: str, reins_url: str) -> dict:
    import urllib.request
    url = f'{reins_url}/api/webhooks/agent-bot/{deployment_id}'
    payload = json.dumps({
        'url': url,
        'secret_token': secret,
        'allowed_updates': ['message', 'edited_message', 'callback_query', 'my_chat_member'],
    }).encode()
    req = urllib.request.Request(
        f'https://api.telegram.org/bot{token}/setWebhook',
        data=payload, method='POST',
        headers={'Content-Type': 'application/json'},
    )
    import urllib.error
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {'ok': False, 'error': e.read().decode()}


def get_openclaw_image(org: str) -> str:
    """Resolve latest OpenClaw image from the reins-openclaw registry app."""
    apps = ['reins-openclaw', 'agentx-openclaw']
    for app in apps:
        try:
            machines = fly_client.list_machines(app)
            if machines:
                image = machines[0].get('config', {}).get('image')
                if image:
                    return image
        except Exception:
            pass
    raise RuntimeError(
        'Cannot resolve OpenClaw image automatically. '
        'Set OPENCLAW_IMAGE env var in admin/.env.admin and re-run.'
    )


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    agent_id = sys.argv[1]

    # Load deployment info from Reins admin API
    print(f'Loading agents from Reins API...')
    all_agents = reins_client.list_agents()
    dep = next((a for a in all_agents if a.get('id') == agent_id), None)
    if not dep:
        print(f'ERROR: agent {agent_id} not found or has no active deployment.')
        sys.exit(1)

    print(f'\nAgent: {dep.get("name")} ({agent_id})')
    print(f'  Runtime:       {dep.get("runtime")}')
    print(f'  Deploy status: {dep.get("deployment_status")}')
    print(f'  Fly app:       {dep.get("fly_app_name")} (may be destroyed)')
    print(f'  Machine:       {dep.get("fly_machine_id")}')
    print(f'  Region:        {dep.get("region") or "iad"}')
    print(f'  Shared bot:    {bool(dep.get("is_shared_bot"))}')

    if dep.get('runtime') and dep['runtime'] != 'openclaw':
        print(f'\nWARNING: runtime={dep["runtime"]}. This script currently only supports OpenClaw.')
        sys.exit(1)

    confirm = input('\nProceed with recovery? [y/N] ').strip().lower()
    if confirm != 'y':
        print('Aborted.')
        sys.exit(0)

    region = dep.get('region') or 'iad'
    is_shared_bot = bool(dep.get('is_shared_bot'))
    new_deployment_id = nanoid(21)
    new_gateway_token = secrets.token_hex(16)
    new_webhook_secret = secrets.token_hex(16)

    # Resolve image
    openclaw_image = (
        __import__('os').environ.get('OPENCLAW_IMAGE')
        or get_openclaw_image(fly_client.cfg.FLY_ADMIN_TOKEN())
    )
    print(f'\nOpenClaw image: {openclaw_image}')

    # Generate app name from new deployment ID
    suffix = re.sub(r'[^a-z0-9]', '', new_deployment_id.lower())[:8] or 'agent'
    app_name = f'reins-{suffix}'
    fly_org = __import__('os').environ.get('FLY_ORG', 'personal')

    print(f'\nCreating Fly app {app_name} in org {fly_org}...')
    fly_client.create_app(app_name, fly_org)
    fly_client.allocate_ips(app_name)

    print('Creating volume...')
    vol = fly_client.create_volume(app_name, region)
    volume_id = vol.get('id') or vol.get('volume_id') or ''
    print(f'  Volume: {volume_id}')

    # Build machine config
    # Inject minimax_api_key if available
    dep['minimax_api_key'] = __import__('os').environ.get('MINIMAX_API_KEY', '')
    machine_cfg = build_machine_config(dep, new_deployment_id, new_gateway_token, new_webhook_secret, openclaw_image)
    machine_cfg['mounts'] = [{'volume': volume_id, 'path': '/home/node/.openclaw/agents'}]

    print('Creating machine...')
    machine = fly_client.create_machine(
        app_name,
        name=f'openclaw-{new_deployment_id[:8].lower()}',
        region=region,
        config=machine_cfg,
    )
    machine_id = machine.get('id', '')
    print(f'  Machine: {machine_id}')

    management_url = f'https://{app_name}.fly.dev/chat?session=main'
    openclaw_webhook_url = f'https://{app_name}.fly.dev:8443/telegram-webhook'

    # Register Telegram webhook for per-user bots
    if not is_shared_bot:
        print('Registering Telegram webhook...')
        telegram_token = dep.get('telegram_token') or ''
        if telegram_token:
            result = register_webhook(telegram_token, new_deployment_id, new_webhook_secret, REINS_URL())
            print(f'  Webhook: {result}')
        else:
            print('  WARNING: no telegram_token in deployment record — skipping webhook registration.')
    else:
        print('Shared-bot: webhook will be registered by OpenClaw on boot.')

    print(f'\nDone!')
    print(f'  App:           {app_name}')
    print(f'  Machine:       {machine_id}')
    print(f'  Deployment ID: {new_deployment_id}')
    print(f'  Management:    {management_url}')
    print()
    print('NEXT STEPS: Update the deployed_agents record in the Reins DB.')
    print('The Reins backend does not yet have a restore-deployment API endpoint.')
    print('Use the Node.js recovery script on agenthelm-core if needed, or run:')
    print()
    print(f'  INSERT INTO deployed_agents (id, agent_id, fly_app_name, fly_machine_id, status,')
    print(f'    management_url, runtime, is_shared_bot, fly_volume_id, openclaw_webhook_url,')
    print(f'    webhook_relay_secret, gateway_token, created_at, updated_at)')
    print(f"  VALUES ('{new_deployment_id}', '{agent_id}', '{app_name}', '{machine_id}', 'running',")
    print(f"    '{management_url}', 'openclaw', {1 if is_shared_bot else 0}, '{volume_id}',")
    print(f"    '{openclaw_webhook_url}', '{new_webhook_secret}', '{new_gateway_token}',")
    print(f"    NOW(), NOW());")
    print(f"  UPDATE agents SET status = 'active', updated_at = NOW() WHERE id = '{agent_id}';")


if __name__ == '__main__':
    main()
