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
    # Bot replies with [SILENT] after sending a Telegram media message to avoid
    # sending a duplicate text response. Treat it as a non-content message so it
    # doesn't override the last substantive reply captured for assertions.
    SILENT_MARKER = "[silent]"
    # OpenClaw sends a greeting/onboarding message when a new session starts
    # (after /new). These messages are not content replies to the scenario prompt.
    GREETING_PREFIXES = (
        "hey! i",
        "hey, i",
        "hi! i",
        "hi, i",
        "hello! i",
        "hello, i",
        "hey there",
    )

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

        # Track message edits for OpenClaw streaming responses.
        # last_message: the most recent non-progress-indicator message from the bot.
        # last_activity_time: updated on ANY bot message/edit (including progress indicators).
        # We settle only when the bot has been fully silent (no activity at all) for
        # settle_seconds — this prevents early exit while the bot is still streaming
        # progress updates behind the scenes.
        #
        # settle_seconds scales with the scenario timeout so heavier scenarios (e.g.
        # OpenTable at 180s) wait long enough for the browser to finish and screenshot.
        # Formula: max(10, timeout_secs // 6)  →  ping=15s, basic-browser=20s, opentable=30s
        # last_message tracks the most recent non-progress text message.
        # best_message tracks the longest/most-substantive message seen — used
        # as the final reply so that intermediate tool-navigation messages
        # (e.g. "navigating to media directory...") don't override the main
        # content reply (e.g. "The #1 trending repo is...").
        last_message = {"text": "", "time": 0.0, "id": None}
        best_message = {"text": "", "time": 0.0, "id": None}
        last_activity_time = [0.0]  # use list so closures can mutate it
        settle_seconds = max(40.0, timeout_secs / 3.0)

        reply_event = asyncio.Event()

        @client.on(events.NewMessage(from_users=bot_entity))
        async def on_new_message(event):
            nonlocal reply_text, screenshots
            # Ignore messages that predated our prompt (leftover from previous scenario)
            if event.message.id <= baseline_msg_id:
                return

            # Always update activity time, even for progress messages
            last_activity_time[0] = time.time()

            text = event.message.message or ""

            # Skip progress indicators, [SILENT] markers, and greeting messages
            # for reply capture, but still track activity above (for settle timer).
            if any(text.startswith(p) for p in SKIP_PREFIXES):
                return
            text_lower = text.strip().lower()
            if text_lower == SILENT_MARKER:
                return
            if any(text_lower.startswith(g) for g in GREETING_PREFIXES):
                return

            # Capture any photo/document attachments
            is_media_message = False
            if event.message.media:
                if isinstance(event.message.media, (MessageMediaPhoto, MessageMediaDocument)):
                    filename = f"screenshot_{int(time.time() * 1000)}.jpg"
                    save_path = results_dir / filename
                    await event.message.download_media(str(save_path))
                    screenshots.append(str(save_path))
                    is_media_message = True

            # For text-only messages: update both last_message and best_message.
            # For media messages: don't overwrite last_message (keeps the prior
            # text reply intact) but DO include the caption in best_message if
            # it's longer (in case the bot puts content in the photo caption).
            if not is_media_message:
                last_message["text"] = text
                last_message["time"] = time.time()
                last_message["id"] = event.message.id
            # Track the longest message as the best candidate for assertions.
            if len(text) > len(best_message["text"]):
                best_message["text"] = text
                best_message["time"] = time.time()
                best_message["id"] = event.message.id
            reply_event.set()

        @client.on(events.MessageEdited(from_users=bot_entity))
        async def on_message_edited(event):
            # Ignore messages that predated our prompt
            if event.message.id <= baseline_msg_id:
                return

            # Always update activity time, even for progress messages
            last_activity_time[0] = time.time()

            text = event.message.message or ""
            if any(text.startswith(p) for p in SKIP_PREFIXES):
                return
            text_lower_e = text.strip().lower()
            if text_lower_e == SILENT_MARKER:
                return
            if any(text_lower_e.startswith(g) for g in GREETING_PREFIXES):
                return
            last_message["text"] = text
            last_message["time"] = time.time()
            last_message["id"] = event.message.id
            if len(text) > len(best_message["text"]):
                best_message["text"] = text
                best_message["time"] = last_message["time"]
                best_message["id"] = last_message["id"]
            # Reset event so we wait for settle
            reply_event.clear()
            reply_event.set()

        # Reset the bot session context before each scenario so that a prior
        # scenario's browser failure doesn't poison the LLM's expectations
        # here. Chrome stays running across /new — only the conversation context
        # is cleared, not the subprocess.
        await client.send_message(bot_entity, "/new")
        # After /new, OpenClaw sends a welcome/greeting message (possibly delayed
        # while it reads workspace files and rebuilds context). We wait for the
        # bot to go quiet, then re-record baseline so the greeting isn't captured
        # as a "reply" to our scenario prompt.
        # Strategy: poll every 5s; once the latest message ID stops changing for
        # 10s (two consecutive stable polls), treat the bot as quiet.
        await asyncio.sleep(15)  # initial settle after /new
        last_seen_id = -1
        for _ in range(10):  # up to 50s more (10 × 5s)
            h = await client.get_messages(bot_entity, limit=1)
            current_id = h[0].id if h else 0
            if current_id == last_seen_id:
                break  # bot quiet — no new messages in the last 5s
            last_seen_id = current_id
            await asyncio.sleep(5)
        # Re-record baseline after bot is quiet; all /new responses are now behind it
        history = await client.get_messages(bot_entity, limit=1)
        if history:
            baseline_msg_id = history[0].id

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

        # Seed activity time from when the first reply arrived (reply_event was set).
        if last_activity_time[0] == 0.0:
            last_activity_time[0] = time.time()

        # Settle: wait until the bot has been completely silent for settle_seconds.
        # We use last_activity_time (not last_message["time"]) so that progress-
        # indicator edits keep the timer alive even though we skip them for reply capture.
        while True:
            since_last = time.time() - last_activity_time[0]
            if since_last >= settle_seconds:
                break
            await asyncio.sleep(0.5)
            # Check overall timeout
            if time.time() - start_time > timeout_secs:
                break

        # Use the most substantive (longest) message for assertions, falling
        # back to the last message if nothing better was captured.
        reply_text = best_message["text"] or last_message["text"]
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
