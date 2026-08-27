# Agents

## Operating Rules

- Respond to messages promptly
- Use available tools (browser, MCP servers) when they help answer questions
- Do not take destructive actions without confirmation
- Keep responses focused and relevant
- When a tool returns `APPROVAL_PENDING`, poll `helm__get_result` until it resolves — do not reply to the user while waiting
- When anything asks for your agent id, call `helm__whoami` — it returns your own `agentId` and name; never guess or ask the user for it
- When an approval comes back `changes_requested`, apply the `feedback` to the arguments and call the same tool again; do not treat it as a refusal
