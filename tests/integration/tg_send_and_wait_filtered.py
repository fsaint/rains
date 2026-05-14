#!/usr/bin/env python3
"""Send a message to a Telegram bot and wait for the first non-progress reply.

Skips progress/welcome prefixes: 🐍 ⚡ 📬 ⚙️ (Hermes progress messages).
Handles OpenClaw streaming via MessageEdited events with a 3-second settle timer.

Usage:
  TELEGRAM_API_ID=... TELEGRAM_API_HASH=... TELEGRAM_PHONE=+1... \
  python3 tg_send_and_wait_filtered.py <bot_username> "<message>" [timeout_secs]

Exit codes:
  0 — reply received and printed to stdout
  1 — timeout expired
"""

import asyncio
import os
import sys
import time

from telethon import TelegramClient, events

SKIP_PREFIXES = ('🐍', '⚡', '📬', '⚙️')
SETTLE_SECS = 3.0
SESSION = os.path.expanduser('~/.reins_test_telethon')


async def main() -> None:
    if len(sys.argv) < 3:
        print(f'Usage: {sys.argv[0]} <bot_username> "<message>" [timeout_secs]', file=sys.stderr)
        sys.exit(1)

    bot_username = sys.argv[1]
    message = sys.argv[2]
    timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 90

    api_id = int(os.environ['TELEGRAM_API_ID'])
    api_hash = os.environ['TELEGRAM_API_HASH']
    phone = os.environ['TELEGRAM_PHONE']

    client = TelegramClient(SESSION, api_id, api_hash)
    await client.start(phone=phone)

    bot = await client.get_entity(bot_username)
    bot_id = bot.id

    state = {'text': None, 'msg_id': None, 'last_edit': 0.0}
    got_reply = asyncio.Event()

    @client.on(events.NewMessage(from_users=bot_id))
    async def on_new(event):
        text = event.message.text or ''
        if any(text.startswith(p) for p in SKIP_PREFIXES):
            return
        state['text'] = text
        state['msg_id'] = event.message.id
        state['last_edit'] = time.monotonic()
        got_reply.set()

    @client.on(events.MessageEdited(from_users=bot_id))
    async def on_edit(event):
        if state['msg_id'] is not None and event.message.id == state['msg_id']:
            state['text'] = event.message.text or ''
            state['last_edit'] = time.monotonic()

    await client.send_message(bot, message)

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        try:
            await asyncio.wait_for(got_reply.wait(), timeout=min(5.0, remaining))
        except asyncio.TimeoutError:
            pass

        if got_reply.is_set():
            # Wait for streaming edits to settle
            while True:
                await asyncio.sleep(SETTLE_SECS)
                if time.monotonic() - state['last_edit'] >= SETTLE_SECS:
                    break
            print(state['text'])
            await client.disconnect()
            return

    print('ERROR: Timeout waiting for bot reply', file=sys.stderr)
    await client.disconnect()
    sys.exit(1)


asyncio.run(main())
