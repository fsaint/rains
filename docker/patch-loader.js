#!/usr/bin/env node
/**
 * Patches the openclaw loader to bypass the contracts.tools requirement
 * for extension plugins (those loaded from /dist/extensions/).
 *
 * Problem: openclaw requires plugins to declare contracts.tools in their
 * manifest before api.registerTool() calls are accepted. The openclaw-mcp-bridge
 * plugin registers dynamic tools (names determined at runtime from MCP server),
 * so it cannot declare them in its static manifest. All api.registerTool() calls
 * from the mcp-bridge are silently dropped.
 *
 * Fix: Skip the contract check when the plugin is loaded from the extensions
 * directory (/dist/extensions/), which holds bundled built-in extensions.
 *
 * The loader filename changes with each build (content-hashed). This script
 * discovers it dynamically. If the anchor text is not found (upstream fixed
 * or refactored the restriction), the script exits 0 — no patch needed.
 */

'use strict';
const fs = require('fs');
const path = require('path');

const DIST_DIR = '/app/dist';

// Find the loader file — content-hashed, e.g. loader-ChBMT90m.js
const loaderFile = fs.readdirSync(DIST_DIR).find(
    f => f.startsWith('loader-') && f.endsWith('.js')
);

if (!loaderFile) {
    console.error('ERROR: no loader-*.js file found in', DIST_DIR);
    process.exit(1);
}

const LOADER_PATH = path.join(DIST_DIR, loaderFile);
console.log('Found loader:', LOADER_PATH);

let src = fs.readFileSync(LOADER_PATH, 'utf8');
const original = src;

// --- Patch 1: bypass "declaredNames.length === 0" check for extension plugins ---
const ANCHOR1 = 'if (declaredNames.length === 0) {\n\t\t\tpushDiagnostic({\n\t\t\t\tlevel: "error",\n\t\t\t\tpluginId: record.id,\n\t\t\t\tsource: record.source,\n\t\t\t\tmessage: "plugin must declare contracts.tools before registering agent tools"\n\t\t\t});\n\t\t\treturn;\n\t\t}';
const REPLACEMENT1 = 'if (declaredNames.length === 0 && !(record.rootDir ?? "").includes("/extensions/")) {\n\t\t\tpushDiagnostic({\n\t\t\t\tlevel: "error",\n\t\t\t\tpluginId: record.id,\n\t\t\t\tsource: record.source,\n\t\t\t\tmessage: "plugin must declare contracts.tools before registering agent tools"\n\t\t\t});\n\t\t\treturn;\n\t\t}';

// --- Patch 2: bypass "undeclared.length > 0" check for extension plugins ---
const ANCHOR2 = 'if (undeclared.length > 0) {\n\t\t\tpushDiagnostic({\n\t\t\t\tlevel: "error",\n\t\t\t\tpluginId: record.id,\n\t\t\t\tsource: record.source,\n\t\t\t\tmessage: `plugin must declare contracts.tools for: ${undeclared.join(", ")}`\n\t\t\t});\n\t\t\treturn;\n\t\t}';
const REPLACEMENT2 = 'if (undeclared.length > 0 && !(record.rootDir ?? "").includes("/extensions/")) {\n\t\t\tpushDiagnostic({\n\t\t\t\tlevel: "error",\n\t\t\t\tpluginId: record.id,\n\t\t\t\tsource: record.source,\n\t\t\t\tmessage: `plugin must declare contracts.tools for: ${undeclared.join(", ")}`\n\t\t\t});\n\t\t\treturn;\n\t\t}';

const anchor1Found = src.includes(ANCHOR1);
const anchor2Found = src.includes(ANCHOR2);

// If neither anchor exists, the restriction may have been removed upstream.
// Check for any mention of "contracts.tools" to confirm.
if (!anchor1Found && !anchor2Found) {
    const hasRestriction = src.includes('contracts.tools');
    if (!hasRestriction) {
        console.log('contracts.tools restriction not found in loader — patch not needed (likely fixed upstream)');
        process.exit(0);
    }
    // Restriction exists but in a different form — log context to help diagnose
    const idx = src.indexOf('contracts.tools');
    const snippet = src.slice(Math.max(0, idx - 200), idx + 200);
    console.warn('WARNING: contracts.tools restriction found but anchor text differs from expected.');
    console.warn('Snippet around restriction:');
    console.warn(snippet);
    console.warn('The patch may need updating. Continuing without patching (may cause tool registration failures).');
    process.exit(0);
}

if (!anchor1Found) {
    console.warn('WARNING: anchor 1 not found — skipping patch 1');
} else {
    src = src.replace(ANCHOR1, REPLACEMENT1);
}

if (!anchor2Found) {
    console.warn('WARNING: anchor 2 not found — skipping patch 2');
} else {
    src = src.replace(ANCHOR2, REPLACEMENT2);
}

if (src === original) {
    console.log('Loader already patched — no changes needed');
    process.exit(0);
}

fs.writeFileSync(LOADER_PATH, src);

const hasP1 = src.includes('!(record.rootDir ?? "").includes("/extensions/")');
console.log('Loader patched successfully:');
console.log('  bypass declaredNames check for extensions:', anchor1Found);
console.log('  bypass undeclared check for extensions:', anchor2Found);

if (!hasP1 && (anchor1Found || anchor2Found)) {
    console.error('ERROR: patches not applied correctly');
    process.exit(1);
}
