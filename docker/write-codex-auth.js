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

// Also register the model in models.json so the gateway recognizes it.
// The doctor creates models.json with an empty openai-codex provider because
// OAuth tokens aren't available at Phase 1; we patch it here in Phase 2.
const modelName = process.env.MODEL_NAME || "gpt-5.4";
const modelsFile = authDir + "/models.json";
let modelsData = { providers: {} };
try {
  modelsData = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
} catch (e) {
  // file doesn't exist yet — start fresh
}
const provider = modelsData.providers["openai-codex"] || {
  baseUrl: "https://chatgpt.com/backend-api/v1",
  api: "openai-codex-responses",
  models: [],
};
// Add model if not already present
if (!provider.models.find((m) => m.id === modelName)) {
  provider.models.push({
    id: modelName,
    name: modelName,
    api: "openai-codex-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 100000,
    compat: { supportsReasoningEffort: true, supportsUsageInStreaming: true },
  });
}
modelsData.providers["openai-codex"] = provider;
fs.writeFileSync(modelsFile, JSON.stringify(modelsData, null, 2));
console.log("models.json patched for openai-codex/" + modelName);
