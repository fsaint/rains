// Writes OpenAI Codex OAuth auth-profiles.json for OpenClaw
// Run as: node write-codex-auth.js (reads OPENAI_CODEX_TOKENS env var)
const fs = require("fs");

const tokensJson = process.env.OPENAI_CODEX_TOKENS;
if (!tokensJson) {
  console.error("OPENAI_CODEX_TOKENS not set");
  process.exit(1);
}

const authDir = (process.env.HOME || "/home/node") + "/.openclaw/agents/main/agent";
const authFile = authDir + "/auth-profiles.json";

fs.mkdirSync(authDir, { recursive: true });

const tokens = JSON.parse(tokensJson);
const parts = tokens.access_token.split(".");
const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
const expiresMs = (payload.exp || 0) * 1000;

const data = {
  version: 1,
  profiles: {
    "openai-codex:default": {
      type: "oauth",
      provider: "openai-codex",
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      id_token: tokens.id_token,
      expires: expiresMs,
    },
  },
};

fs.writeFileSync(authFile, JSON.stringify(data, null, 2));
console.log("Codex auth-profiles.json written to " + authFile);
