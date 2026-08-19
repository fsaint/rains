/**
 * Helpers shared by the server handler tests.
 */

import type { ToolResult } from './types.js';

/**
 * Read the payload of a handler result.
 *
 * Handlers are declared `Promise<ToolResult>`, and `ToolResult` defaults its
 * payload to `unknown`, so `result.data.messageId` does not compile. A test
 * that asserts on a field already knows the shape it asked for, so it reads it
 * through here instead of restating the type at every assertion.
 *
 * This deliberately gives up type checking on the payload of those assertions.
 * The alternative — parameterising every handler's return type — is worth doing,
 * and until it is done this keeps the rest of the workspace type checked rather
 * than leaving the whole package failing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function data<T = any>(result: ToolResult): T {
  return result.data as T;
}
