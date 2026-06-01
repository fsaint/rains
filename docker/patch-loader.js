#!/usr/bin/env node
/**
 * Patches /app/dist/loader-ChBMT90m.js to bypass the contracts.tools requirement
 * for extension plugins (those loaded from /dist/extensions/).
 *
 * Problem: openclaw 2026.5.27 requires plugins to declare contracts.tools in their
 * manifest before api.registerTool() calls are accepted. The openclaw-mcp-bridge
 * plugin registers dynamic tools (names determined at runtime from MCP server),
 * so it cannot declare them in its static manifest. All api.registerTool() calls
 * from the mcp-bridge are silently dropped with a "plugin must declare contracts.tools"
 * diagnostic error.
 *
 * Fix: Skip the contract check when the plugin is loaded from the extensions directory
 * (/dist/extensions/ or /dist-runtime/extensions/), which are bundled built-in extensions.
 */

'use strict';
const fs = require('fs');
const path = require('path');

const LOADER_PATH = '/app/dist/loader-ChBMT90m.js';
let src = fs.readFileSync(LOADER_PATH, 'utf8');
const original = src;

// --- Patch 1: bypass "declaredNames.length === 0" check for extension plugins ---
const ANCHOR1 = 'if (declaredNames.length === 0) {\n\t\t\tpushDiagnostic({\n\t\t\t\tlevel: "error",\n\t\t\t\tpluginId: record.id,\n\t\t\t\tsource: record.source,\n\t\t\t\tmessage: "plugin must declare contracts.tools before registering agent tools"\n\t\t\t});\n\t\t\treturn;\n\t\t}';
const REPLACEMENT1 = 'if (declaredNames.length === 0 && !(record.rootDir ?? "").includes("/extensions/")) {\n\t\t\tpushDiagnostic({\n\t\t\t\tlevel: "error",\n\t\t\t\tpluginId: record.id,\n\t\t\t\tsource: record.source,\n\t\t\t\tmessage: "plugin must declare contracts.tools before registering agent tools"\n\t\t\t});\n\t\t\treturn;\n\t\t}';

if (!src.includes(ANCHOR1)) {
    console.error('ERROR: anchor 1 not found — loader layout may have changed');
    process.exit(1);
}
src = src.replace(ANCHOR1, REPLACEMENT1);

// --- Patch 2: bypass "undeclared.length > 0" check for extension plugins ---
const ANCHOR2 = 'if (undeclared.length > 0) {\n\t\t\tpushDiagnostic({\n\t\t\t\tlevel: "error",\n\t\t\t\tpluginId: record.id,\n\t\t\t\tsource: record.source,\n\t\t\t\tmessage: `plugin must declare contracts.tools for: ${undeclared.join(", ")}`\n\t\t\t});\n\t\t\treturn;\n\t\t}';
const REPLACEMENT2 = 'if (undeclared.length > 0 && !(record.rootDir ?? "").includes("/extensions/")) {\n\t\t\tpushDiagnostic({\n\t\t\t\tlevel: "error",\n\t\t\t\tpluginId: record.id,\n\t\t\t\tsource: record.source,\n\t\t\t\tmessage: `plugin must declare contracts.tools for: ${undeclared.join(", ")}`\n\t\t\t});\n\t\t\treturn;\n\t\t}';

if (!src.includes(ANCHOR2)) {
    console.error('ERROR: anchor 2 not found — loader layout may have changed');
    process.exit(1);
}
src = src.replace(ANCHOR2, REPLACEMENT2);

if (src === original) {
    console.log('Loader already patched — no changes needed');
    process.exit(0);
}

fs.writeFileSync(LOADER_PATH, src);

const hasP1 = src.includes('!(record.rootDir ?? "").includes("/extensions/")');
console.log('Loader patched:');
console.log('  bypass declaredNames check for extensions:', hasP1);
console.log('  bypass undeclared check for extensions:', hasP1);

if (!hasP1) {
    console.error('ERROR: patches not applied correctly');
    process.exit(1);
}
