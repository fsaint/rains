#!/usr/bin/env node
/**
 * Patches openclaw-mcp-bridge/dist/index.js in-place after npm install.
 *
 * Problem: openclaw's plugin system drops api.registerTool() calls made
 * asynchronously after register() returns. The mcp-bridge plugin uses an
 * async .then() callback to register tools after the MCP connection resolves,
 * which means tools are never visible to the agent.
 *
 * Fix (applied here + in entrypoint.sh):
 *   1. Add readFileSync import at module top level.
 *   2. Patch the early return to fall back to MCP_CONFIG env var when api.pluginConfig
 *      has no servers. When openclaw loads this as a built-in extension (from
 *      /dist/extensions/), api.pluginConfig is null — the env var fallback ensures
 *      the plugin still initialises with the correct server URLs.
 *   3. Insert synchronous cache-reading code in register() that reads
 *      /tmp/mcp-tools-cache.json (written by entrypoint before Phase 3 exec)
 *      and registers tools synchronously — before the existing async .then() block.
 *   4. Add id: "openclaw-mcp-bridge" to the default export so openclaw's plugin
 *      loader recognises the plugin (reads module.default.id at load time).
 */

'use strict';
const fs = require('fs');

const PLUGIN_PATH = '/app/dist/extensions/openclaw-mcp-bridge/dist/index.js';
let src = fs.readFileSync(PLUGIN_PATH, 'utf8');
const original = src;

// --- Patch 1: add readFileSync import ------------------------------------------
const IMPORT_ANCHOR = 'import { handleMCPCommand } from "./commands/mcp-manage.js";';
if (!src.includes('_readFileSync')) {
    if (!src.includes(IMPORT_ANCHOR)) {
        console.error('ERROR: import anchor not found — plugin layout may have changed');
        process.exit(1);
    }
    src = src.replace(
        IMPORT_ANCHOR,
        IMPORT_ANCHOR + '\nimport { readFileSync as _readFileSync } from "fs";'
    );
}

// --- Patch 2: fallback to MCP_CONFIG env var when api.pluginConfig has no servers ----
// When openclaw loads the mcp-bridge as a built-in extension (from /dist/extensions/),
// api.pluginConfig is null because user plugin entries in openclaw.json haven't been
// applied yet. Without this patch, register() returns early and no tools are registered
// at gateway startup. This fallback reads MCP_CONFIG (always set by our entrypoint)
// so the plugin initialises with the correct server URL from the first register() call.
const EARLY_RETURN_ANCHOR = 'const config = api.pluginConfig;\n    if (!config?.servers || Object.keys(config.servers).length === 0) {\n        return;\n    }';
if (!src.includes('_mcp_env_fallback')) {
    if (!src.includes(EARLY_RETURN_ANCHOR)) {
        console.error('ERROR: early-return anchor not found — plugin layout may have changed');
        process.exit(1);
    }
    const EARLY_RETURN_REPLACEMENT = `let config = api.pluginConfig;
    if (!config?.servers || Object.keys(config.servers).length === 0) {
        // _mcp_env_fallback: api.pluginConfig is null when openclaw loads this as a
        // built-in extension before user plugin entries are applied. Fall back to
        // MCP_CONFIG env var so tools are registered synchronously at gateway start.
        try {
            const _mcp_env_cfg = JSON.parse(process.env.MCP_CONFIG || '[]');
            const _mcp_env_srvs = {};
            for (const _mcp_s of _mcp_env_cfg) { if (_mcp_s.name && _mcp_s.url) _mcp_env_srvs[_mcp_s.name] = { url: _mcp_s.url }; }
            if (Object.keys(_mcp_env_srvs).length > 0) config = { ...(config || {}), servers: _mcp_env_srvs };
        } catch (_mcp_env_err) {}
        if (!config?.servers || Object.keys(config.servers).length === 0) return;
    }`;
    src = src.replace(EARLY_RETURN_ANCHOR, EARLY_RETURN_REPLACEMENT);
}

// --- Patch 3: insert synchronous cache-reading code ----------------------------
const SYNC_MARKER = '// Register tools into THIS api context once the shared connection resolves.';
if (!src.includes('_mcp_cached')) {
    if (!src.includes(SYNC_MARKER)) {
        console.error('ERROR: sync marker not found — plugin layout may have changed');
        process.exit(1);
    }
    const cacheCode = `// *** SYNC: Pre-register tools from entrypoint MCP cache (written before gateway starts) ***
    // openclaw drops api.registerTool() calls made after register() returns. The entrypoint
    // writes /tmp/mcp-tools-cache.json before Phase 3 exec so tools register synchronously.
    let _mcp_cached = [];
    try { _mcp_cached = JSON.parse(_readFileSync('/tmp/mcp-tools-cache.json', 'utf8')); } catch (_e) {}
    const _mcp_cm = sharedManager;
    for (const _mcp_rt of _mcp_cached) {
        api.registerTool({
            name: _mcp_rt.namespacedName,
            label: (_mcp_rt.description || '').slice(0, 60) || _mcp_rt.namespacedName,
            description: _mcp_rt.description || '',
            parameters: buildTypeBoxSchema(_mcp_rt.inputSchema),
            async execute(_mcp_id, _mcp_params) {
                if (connectPromise) await connectPromise.catch(() => {});
                if (!_mcp_cm) return makeErrorResult(_mcp_rt.namespacedName, new Error('No MCP manager'));
                try { return makeToolResult(await _mcp_cm.callTool(_mcp_rt.namespacedName, _mcp_params)); }
                catch (_mcp_err) { return makeErrorResult(_mcp_rt.namespacedName, _mcp_err); }
            },
        });
    }
    if (_mcp_cached.length > 0) {
        api.logger.info('mcp-bridge: pre-registered ' + _mcp_cached.length + ' cached tools synchronously');
    }
    `;
    src = src.replace(SYNC_MARKER, cacheCode + '\n    ' + SYNC_MARKER);
}

// --- Patch 4: add id to default export -----------------------------------------
if (!src.includes('id: "openclaw-mcp-bridge"')) {
    src = src.replace(
        'export default { register };',
        'export default { id: "openclaw-mcp-bridge", register };'
    );
}

if (src === original) {
    console.log('Plugin already patched — all anchors found, no changes needed');
    process.exit(0);
}

fs.writeFileSync(PLUGIN_PATH, src);

const hasId = src.includes('id: "openclaw-mcp-bridge"');
const hasFsImport = src.includes('_readFileSync');
const hasCacheCode = src.includes('_mcp_cached');
const hasEnvFallback = src.includes('_mcp_env_fallback');

console.log('Plugin patched:');
console.log('  id in default export:', hasId);
console.log('  readFileSync import:', hasFsImport);
console.log('  MCP_CONFIG env fallback:', hasEnvFallback);
console.log('  sync cache-reading code:', hasCacheCode);

if (!hasId || !hasFsImport || !hasCacheCode || !hasEnvFallback) {
    console.error('ERROR: one or more patches failed');
    process.exit(1);
}
