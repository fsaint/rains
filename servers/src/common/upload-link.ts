/**
 * create_upload_link: the way a file on the agent's own machine becomes an
 * attachment, without its bytes passing through the model's context.
 *
 * The `upload` attachment source has always existed, but staging a file
 * required the gateway token, which only something running inside Helm can
 * read. When an agent ran in a Helm container that was fine — the token was
 * an environment variable. Agents now run on the user's own machine as remote
 * MCP clients, where that token is unavailable and unobtainable, so the only
 * local-file route left was inline base64: every byte emitted as model output,
 * slow, and corrupting above a few kilobytes.
 *
 * This tool closes that gap. It asks Helm for a short-lived capability and
 * returns a ready-to-run command. The agent runs the command against its own
 * file, gets back an uploadId, and passes that id to gmail_create_draft or
 * drive_create_file.
 *
 * One implementation, registered under each service's own prefix, because the
 * registry requires every tool name to carry the prefix of the service that
 * exposes it. The uploadId a link produces works for both.
 */

import type { ToolDefinition } from './base-server.js';
import type { ServerContext, ToolResult } from './types.js';

function getApiBase(): string {
  return (process.env.REINS_API_URL ?? 'https://app.helm.mom').replace(/\/$/, '');
}

export interface UploadLinkArgs {
  filename?: unknown;
  mimeType?: unknown;
  localPath?: unknown;
}

export async function handleCreateUploadLink(
  args: UploadLinkArgs,
  context: ServerContext
): Promise<ToolResult> {
  const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
  if (filename === '') {
    return { success: false, error: 'filename is required — the name the file should have once attached.' };
  }

  const token = context.gatewayToken ?? process.env.REINS_GATEWAY_TOKEN ?? '';
  if (!token) {
    return {
      success: false,
      error: 'Upload links are unavailable for this agent (no gateway token).',
    };
  }

  let response: Response;
  try {
    response = await fetch(`${getApiBase()}/api/agent-uploads/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-reins-agent-secret': token },
      body: JSON.stringify({
        filename,
        mimeType: typeof args.mimeType === 'string' ? args.mimeType : undefined,
        localPath: typeof args.localPath === 'string' ? args.localPath : undefined,
      }),
    });
  } catch (error) {
    return { success: false, error: `Could not reach Helm to mint an upload link: ${(error as Error).message}` };
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      // Body was not JSON; the status is all there is to report.
    }
    return { success: false, error: `Could not mint an upload link: ${detail}` };
  }

  const body = (await response.json()) as {
    data: { url: string; token: string; expiresAt: string; maxBytes: number; curl: string };
  };
  const link = body.data;

  return {
    success: true,
    data: {
      upload_url: link.url,
      expires_at: link.expiresAt,
      max_bytes: link.maxBytes,
      curl: link.curl,
      next_step:
        'Run the curl command in your shell, replacing the path if it is not already correct. ' +
        'It prints JSON containing an upload id at data.id. Pass that id as ' +
        '{"source":"upload","uploadId":"<id>"} to attach the file. The link expires, and the ' +
        'staged file is kept for 24 hours.',
    },
  };
}

const DESCRIPTION =
  'Get a short-lived link for uploading a file that is on YOUR machine, so it can be ' +
  'attached to an email or saved to Drive without its bytes passing through your context. ' +
  'Use this for any local file above a few KB — it is the right tool whenever you would ' +
  'otherwise reach for source="base64". Returns a ready-to-run curl command: run it, read ' +
  'the upload id from data.id in its output, then pass {"source":"upload","uploadId":"<id>"} ' +
  'as the attachment or file. Does NOT apply to files already in Gmail or Drive — forward ' +
  'those with source="gmail" or source="drive", which never leave the server.';

const INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    filename: {
      type: 'string',
      description:
        'The name the file should have once attached, including its extension, ' +
        'e.g. "ROI - MCDS.pdf". Required. Bound into the link, so one link uploads one file.',
    },
    mimeType: {
      type: 'string',
      description:
        'Content type, e.g. "application/pdf". Optional — inferred from the filename when omitted.',
    },
    localPath: {
      type: 'string',
      description:
        'The full path to the file on your machine, e.g. "/Users/you/Desktop/ROI - MCDS.pdf". ' +
        'Optional, but pass it: the returned command is then correct as written, quoting included. ' +
        'The path is only rendered into that command and is never stored.',
    },
  },
  required: ['filename'],
};

/** Build the tool under one service's prefix. */
export function createUploadLinkTool(prefix: 'gmail_' | 'drive_'): ToolDefinition {
  return {
    name: `${prefix}create_upload_link`,
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    handler: handleCreateUploadLink,
  };
}
