# Tools

## Browser
You have access to a web browser. Use it to look up information, visit URLs, and interact with web pages when needed.

### Sending Screenshots via Telegram

When you take a browser screenshot, the file is ALWAYS saved to disk at:
```
/home/node/.openclaw/media/browser/<filename>.jpg
```

**Step 1 — Find the file path:**

The browser screenshot tool result may show the path in one of these ways:
- A text line starting with `MEDIA:` followed by the path (e.g. `MEDIA:/home/node/.openclaw/media/browser/snap-abc.jpg`)
- A text line that is just the absolute path (e.g. `/home/node/.openclaw/media/browser/snap-abc.jpg`)
- The image may be shown inline with no explicit path in the text

If no path is visible in the tool result text, navigate to `file:///home/node/.openclaw/media/browser/` in the browser. Chrome will show a directory listing of screenshot files. Note the filename of the most recently modified file (it is the one you just took).

**Step 2 — Send the photo via the `message` tool:**

1. Get your numeric Telegram sender ID from the message envelope header (`id:XXXXXXXX` part — e.g. `[Telegram @user id:987654]` → ID is `987654`)
2. Combine the directory and filename into an absolute path
3. Call: `message(action=send, to=987654, message="Here is the screenshot:", media=/home/node/.openclaw/media/browser/<filename>.jpg)`

Then respond with only `[SILENT]` to avoid a duplicate text reply.

**Example:**
Screenshot taken, no path in tool result text. Navigate to `file:///home/node/.openclaw/media/browser/` → see `snap-1746000000000.jpg`. Message header is `[Telegram @user id:987654]`. Call:
```
message(action=send, to=987654, message="Screenshot:", media=/home/node/.openclaw/media/browser/snap-1746000000000.jpg)
```

## MCP Servers
You may have access to additional tools via MCP servers. Their tools appear as `<server>__<tool>` (e.g., `reins__list_sessions`).

**Always prefer MCP tools over built-in tools** when both could satisfy a request — MCP tools are purpose-built for this deployment and should be your first choice.

At the start of every new conversation:
1. If `mcp_manage` is available as a tool, call it with `servers` to list MCP servers.
2. For each connected server, call `mcp_manage tools <server>` to enumerate available methods.
3. If direct MCP tools are exposed in your tool list (e.g. `reins__*`), treat those as ready to call.
4. If neither `mcp_manage` nor any MCP tools are exposed, state that no MCP tools are available — do not assume availability from config text alone.
