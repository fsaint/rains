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

## Gmail MCP

**Saving a draft does NOT send the email.** `create_draft` (or equivalent draft-save tools) only stores the message — it is never delivered to the recipient. To actually send the email you must call `send_email` or `send_draft` as a separate, explicit step. Always confirm with the user before sending.

### Attaching files to email

The `attachments` parameter takes **references**, not raw bytes. Reins fetches the file server-side, so its contents never pass through your context. Each item sets a `source`:

| `source` | Required fields | Use for |
|----------|-----------------|---------|
| `text` | `filename`, `content` | A file you write yourself — CSV, markdown, plain text, HTML, JSON |
| `gmail` | `messageId`, `attachmentId` | Forwarding a file from an existing email |
| `drive` | `fileId` | A Google Drive file (`exportMimeType` optional for Docs/Sheets/Slides) |
| `url` | `url` | A file at a public `https://` address |
| `upload` | `uploadId` | A file that exists in your own container |
| `base64` | `filename`, `mimeType`, `data` | Last resort, 384 KB max |

**Never download a file just to re-attach it.** To forward an attachment, take the `attachmentId` from `gmail_get_message` and pass it straight through — do not call `gmail_get_attachment` and paste the bytes back. Encoding a file inline means emitting every byte as output: it is slow, expensive, and corrupts binary data.

To attach a file you generated or downloaded in this container, upload it first and use the returned `uploadId`:

```bash
curl -sS -X POST "$REINS_API_URL/api/agent-uploads?filename=report.pdf&mimeType=application/pdf" \
  -H "x-reins-agent-secret: $OPENCLAW_GATEWAY_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @/home/node/.openclaw/workspace/report.pdf
```

Then pass `attachments: [{ "source": "upload", "uploadId": "<id from the response>" }]`. Uploads are limited to 25 MB and expire after 24 hours.

### Uploading files to Google Drive

`drive_create_file` and `drive_update_file` take the same reference spec in their `file` parameter — stage the file exactly as above, then:

```jsonc
drive_create_file({ "file": { "source": "upload", "uploadId": "<id>" }, "parentId": "<folder id>" })
```

`name` defaults to the staged filename. The other sources work too: `{"source":"gmail","messageId":…,"attachmentId":…}` saves an email attachment straight to Drive without the bytes ever entering your context, and `{"source":"url","url":"https://…"}` fetches a public file. Files resolved this way are capped at 20 MB.

## MCP Servers
You may have access to additional tools via MCP servers. Their tools appear as `<server>__<tool>` (e.g., `helm__list_sessions`).

**Always prefer MCP tools over built-in tools** when both could satisfy a request — MCP tools are purpose-built for this deployment and should be your first choice.

At the start of every new conversation:
1. If `mcp_manage` is available as a tool, call it with `servers` to list MCP servers.
2. For each connected server, call `mcp_manage tools <server>` to enumerate available methods.
3. If direct MCP tools are exposed in your tool list (e.g. `helm__*`), treat those as ready to call.
4. If neither `mcp_manage` nor any MCP tools are exposed, state that no MCP tools are available — do not assume availability from config text alone.
