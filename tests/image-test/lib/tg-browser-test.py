#!/usr/bin/env python3
"""
Telethon-based browser test driver for image-test framework.

Sends a prompt to a Telegram bot, waits for a non-progress reply,
captures any screenshot attachments, and outputs a JSON result.

Usage:
    python3 tg-browser-test.py <bot_username> <prompt> <timeout_secs> <results_dir>

Output (stdout): JSON object
    {
        "reply": "<full bot reply text>",
        "screenshots": ["<path-to-saved-file>", ...],
        "elapsed_s": 42.1,
        "ok": true
    }

Environment variables required:
    TELETHON_API_ID
    TELETHON_API_HASH
    TELETHON_SESSION  (path to .session file, defaults to ~/.reins_imgtest_telethon.session)
    TELEGRAM_PHONE    (only needed on first login)
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path


def usage():
    print("Usage: tg-browser-test.py <bot_username> <prompt> <timeout_secs> <results_dir>", file=sys.stderr)
    sys.exit(1)


async def run(bot_username: str, prompt: str, timeout_secs: int, results_dir: Path) -> dict:
    try:
        from telethon import TelegramClient, events
        from telethon.tl.types import MessageMediaPhoto, MessageMediaDocument
    except ImportError:
        return {
            "ok": False,
            "error": "telethon not installed. Run: pip3 install telethon",
            "reply": "",
            "screenshots": [],
            "elapsed_s": 0,
        }

    api_id = int(os.environ["TELETHON_API_ID"])
    api_hash = os.environ["TELETHON_API_HASH"]
    session_path = os.path.expanduser(os.environ.get(
        "TELETHON_SESSION",
        str(Path.home() / ".reins_imgtest_telethon.session"),
    ))

    # Progress/welcome prefixes to skip (same as integration-test skill)
    SKIP_PREFIXES = ("🐍", "⚡", "📬", "⚙️")

    results_dir.mkdir(parents=True, exist_ok=True)
    screenshots = []
    reply_text = ""
    start_time = time.time()

    async with TelegramClient(session_path, api_id, api_hash) as client:
        # Resolve the bot entity
        bot_entity = await client.get_entity(bot_username)

        # Record the last message ID from the bot before we send our prompt.
        # This lets us ignore any in-flight replies from a previous scenario.
        baseline_msg_id = 0
        history = await client.get_messages(bot_entity, limit=1)
        if history:
            baseline_msg_id = history[0].id

        # Track message edits for OpenClaw streaming responses
        last_message = {"text": "", "time": 0.0, "id": None}
        settle_seconds = 8.0  # wait this long after last activity before accepting

        reply_event = asyncio.Event()

        @client.on(events.NewMessage(from_users=bot_entity))
        async def on_new_message(event):
            nonlocal reply_text, screenshots
            # Ignore messages that predated our prompt (leftover from previous scenario)
            if event.message.id <= baseline_msg_id:
                return

            text = event.message.message or ""

            # Skip progress indicators
            if any(text.startswith(p) for p in SKIP_PREFIXES):
                return

            # Capture any photo/document attachments
            if event.message.media:
                if isinstance(event.message.media, (MessageMediaPhoto, MessageMediaDocument)):
                    filename = f"screenshot_{int(time.time() * 1000)}.jpg"
                    save_path = results_dir / filename
                    await event.message.download_media(str(save_path))
                    screenshots.append(str(save_path))

            last_message["text"] = text
            last_message["time"] = time.time()
            last_message["id"] = event.message.id
            reply_event.set()

        @client.on(events.MessageEdited(from_users=bot_entity))
        async def on_message_edited(event):
            # Ignore messages that predated our prompt
            if event.message.id <= baseline_msg_id:
                return
            text = event.message.message or ""
            if any(text.startswith(p) for p in SKIP_PREFIXES):
                return
            last_message["text"] = text
            last_message["time"] = time.time()
            last_message["id"] = event.message.id
            # Reset event so we wait for settle
            reply_event.clear()
            reply_event.set()

        # Send the prompt
        await client.send_message(bot_entity, prompt)

        # Wait for first reply
        try:
            await asyncio.wait_for(reply_event.wait(), timeout=timeout_secs)
        except asyncio.TimeoutError:
            elapsed = time.time() - start_time
            return {
                "ok": False,
                "error": f"Timeout after {timeout_secs}s — no reply received",
                "reply": "",
                "screenshots": screenshots,
                "elapsed_s": round(elapsed, 1),
            }

        # Settle: wait for edits to stop (OpenClaw streams via message edits)
        while True:
            since_last = time.time() - last_message["time"]
            if since_last >= settle_seconds:
                break
            await asyncio.sleep(0.5)
            # Check overall timeout
            if time.time() - start_time > timeout_secs:
                break

        reply_text = last_message["text"]
        elapsed = time.time() - start_time

        return {
            "ok": True,
            "reply": reply_text,
            "screenshots": screenshots,
            "elapsed_s": round(elapsed, 1),
        }


def main():
    if len(sys.argv) != 5:
        usage()

    bot_username = sys.argv[1]
    prompt = sys.argv[2]
    timeout_secs = int(sys.argv[3])
    results_dir = Path(sys.argv[4])

    result = asyncio.run(run(bot_username, prompt, timeout_secs, results_dir))
    print(json.dumps(result, indent=2))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
