#!/usr/bin/env python3
"""Send a message to a Telegram bot, optionally handle an approval, and return the final reply.

Uses curl for Reins API calls (login, approval queue, approve/reject).
Handles OpenClaw streaming via MessageEdited events + 3-second settle timer.

Usage:
  TELEGRAM_API_ID=... TELEGRAM_API_HASH=... TELEGRAM_PHONE=+1... \
  REINS_URL=http://localhost:5001 \
  REINS_ADMIN_EMAIL=admin@reins.local \
  REINS_ADMIN_PASSWORD=testpass123 \
  python3 tg_mcp_tool_test.py <bot_username> <agent_id> "<message>" <action> [timeout_secs]

  action: "none" | "approve" | "reject"

Exit codes:
  0 — reply received and printed to stdout
  1 — timeout expired
"""

import asyncio
import json
import os
import subprocess
import sys
import time

from telethon import TelegramClient, events

SKIP_PREFIXES = ('🐍', '⚡', '📬', '⚙️', '⏳')
SETTLE_SECS = 15.0
SESSION = os.path.expanduser('~/.reins_test_telethon')
COOKIES_FILE = '/tmp/reins_test_cookies.txt'


def _curl(*args: str) -> str:
    result = subprocess.run(['curl', '-s', *args], capture_output=True, text=True)
    return result.stdout


def login() -> None:
    reins_url = os.environ['REINS_URL']
    email = os.environ['REINS_ADMIN_EMAIL']
    password = os.environ['REINS_ADMIN_PASSWORD']
    _curl(
        '-c', COOKIES_FILE, '-X', 'POST',
        f'{reins_url}/api/auth/login',
        '-H', 'Content-Type: application/json',
        '-d', json.dumps({'email': email, 'password': password}),
    )


def get_pending_approval(agent_id: str) -> str | None:
    reins_url = os.environ['REINS_URL']
    raw = _curl('-b', COOKIES_FILE, f'{reins_url}/api/approvals?agentId={agent_id}')
    try:
        data = json.loads(raw)
        for a in data.get('data', []):
            if a.get('status') == 'pending':
                return a['id']
    except (json.JSONDecodeError, KeyError):
        pass
    return None


def take_action(approval_id: str, action: str) -> None:
    reins_url = os.environ['REINS_URL']
    _curl(
        '-b', COOKIES_FILE, '-X', 'POST',
        f'{reins_url}/api/approvals/{approval_id}/{action}',
        '-H', 'Content-Type: application/json',
        '-d', '{}',
    )


async def main() -> None:
    if len(sys.argv) < 5:
        print(
            f'Usage: {sys.argv[0]} <bot_username> <agent_id> "<message>" <action> [timeout_secs]',
            file=sys.stderr,
        )
        sys.exit(1)

    bot_username = sys.argv[1]
    agent_id = sys.argv[2]
    message = sys.argv[3]
    action = sys.argv[4]   # none | approve | reject
    timeout = int(sys.argv[5]) if len(sys.argv) > 5 else 120

    api_id = int(os.environ['TELEGRAM_API_ID'])
    api_hash = os.environ['TELEGRAM_API_HASH']
    phone = os.environ['TELEGRAM_PHONE']

    if action != 'none':
        login()

    client = TelegramClient(SESSION, api_id, api_hash)
    await client.start(phone=phone)

    bot = await client.get_entity(bot_username)
    bot_id = bot.id

    # Snapshot the latest bot message ID before sending so we can ignore stale cached replies.
    baseline_msgs = await client.get_messages(bot, limit=1)
    baseline_id = baseline_msgs[0].id if baseline_msgs else 0

    state = {'text': None, 'msg_id': None, 'last_edit': 0.0}
    got_reply = asyncio.Event()

    @client.on(events.NewMessage(from_users=bot_id))
    async def on_new(event):
        if event.message.id <= baseline_id:
            return  # stale cached message, ignore
        text = event.message.text or ''
        if any(text.startswith(p) for p in SKIP_PREFIXES):
            return
        state['text'] = text
        state['msg_id'] = event.message.id
        state['last_edit'] = time.monotonic()
        got_reply.set()

    @client.on(events.MessageEdited(from_users=bot_id))
    async def on_edit(event):
        if event.message.id <= baseline_id:
            return  # stale cached message, ignore
        if state['msg_id'] is not None and event.message.id == state['msg_id']:
            state['text'] = event.message.text or ''
            state['last_edit'] = time.monotonic()

    await client.send_message(bot, message)

    deadline = time.monotonic() + timeout
    approval_handled = False

    # Run approval polling as a concurrent background task so it continues
    # even after the first bot message arrives and we enter the settle timer.
    async def approval_poller():
        nonlocal approval_handled
        while time.monotonic() < deadline and not approval_handled:
            approval_id = get_pending_approval(agent_id)
            if approval_id:
                take_action(approval_id, action)
                approval_handled = True
                return
            await asyncio.sleep(1.0)

    poller_task = None
    if action != 'none':
        poller_task = asyncio.create_task(approval_poller())

    try:
        # Wait for first non-skip bot reply
        try:
            await asyncio.wait_for(got_reply.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            print('ERROR: Timeout waiting for bot reply', file=sys.stderr)
            await client.disconnect()
            sys.exit(1)

        # Wait for streaming edits to settle (approval poller still running in background)
        while True:
            await asyncio.sleep(SETTLE_SECS)
            if time.monotonic() - state['last_edit'] >= SETTLE_SECS:
                break

        print(state['text'])
    finally:
        if poller_task and not poller_task.done():
            poller_task.cancel()
    await client.disconnect()


asyncio.run(main())
