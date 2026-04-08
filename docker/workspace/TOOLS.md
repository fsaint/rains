# Tools

## Browser
You have access to a web browser. Use it to look up information, visit URLs, and interact with web pages when needed.

## MCP Servers
You may have access to additional tools via MCP servers connected through the Reins trust layer.

### How to call MCP tools

MCP tools are exposed through a proxy tool named `<server>__call` (e.g. `reins__call`).
Always pass **two separate fields**: `tool` (the tool name) and `args` (the arguments object).

**Correct format:**
```json
{
  "tool": "gmail_search",
  "args": {
    "account": "user@example.com",
    "query": "in:inbox",
    "maxResults": 20
  }
}
```

**Wrong — do NOT embed args in the tool name string:**
```json
{ "tool": "gmail_search {\"account\": \"user@example.com\"}" }
```

For tools that take no arguments, `args` can be omitted:
```json
{ "tool": "gmail_list_accounts" }
```

The available tool names and their parameters are listed in the system context under **MCP Tools Available**.
