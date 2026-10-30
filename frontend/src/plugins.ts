/**
 * The desktop plugins offered for download from the dashboard.
 *
 * The files live in `frontend/public/downloads/`, so they ship with the build
 * and are served from the app's own origin. That is why `file` here is a bare
 * filename rather than a URL: a plugin that is listed but not committed would
 * be a dead button, and plugins.test.ts fails on exactly that.
 *
 * Adding a version means dropping the new zip in that folder, updating the
 * entry below, and deploying. There is no registry to fall out of step with.
 */

export interface PluginDownload {
  /** Stable key, also the React list key. */
  id: 'chatgpt' | 'claude';
  /** The client this plugin is for, as its users name it. */
  client: string;
  version: string;
  /** Filename inside `frontend/public/downloads/`: a zip, or a .plugin (also a zip). */
  file: string;
  /** Exact byte count, so the UI never has to guess at a size. */
  bytes: number;
  /** One line on what installing it does. */
  summary: string;
  /**
   * Install steps, in order, as plain sentences. Shown under the download so a
   * person can finish setup without leaving the page.
   */
  install: string[];
}

export const PLUGIN_DOWNLOADS: PluginDownload[] = [
  {
    id: 'claude',
    client: 'Claude',
    version: '0.3.0',
    file: 'helm-claude-0.3.0.plugin',
    bytes: 43714,
    summary:
      'Locks each Claude project to one agent, with its live skills, threads, memory and skill authoring.',
    install: [
      'Claude desktop or Cowork: upload the .plugin file as a custom plugin, then sign in to helm-root when Claude asks.',
      'Claude Code: unzip the .plugin file (it is a zip) into a folder and start Claude with `claude --plugin-dir <folder>`.',
      'Add each agent you work in as a custom connector, using its MCP URL from the list above, and sign in to it.',
      'In each project, ask Claude to "lock this project to <agent>". In Claude Code, restart in that folder and sign in to the helm server with /mcp.',
      'In a claude.ai Project, paste `Helm scope: <agent> — <MCP URL>` into the project instructions instead.',
    ],
  },
  {
    id: 'chatgpt',
    client: 'ChatGPT',
    version: '0.3.0',
    file: 'helm-chatgpt-0.3.0.zip',
    bytes: 16309,
    summary:
      'Adds Helm sessions, memory, threads and skills to ChatGPT through the discovery endpoint.',
    install: [
      'Unzip it into its own folder.',
      'In ChatGPT desktop, open Plugin Creator, add the folder to a personal marketplace and install Helm. Sign in to helm-directory when asked.',
      'For each agent you work in: Plugins → Add custom MCP server, paste its MCP URL from the list above, choose OAuth and sign in.',
      'To lock a ChatGPT project to one agent, add `Helm scope: <agent> — <MCP URL>` to the project instructions.',
    ],
  },
];

/** Where the browser fetches a plugin from. Same origin as the dashboard. */
export function pluginUrl(plugin: PluginDownload): string {
  return `/downloads/${plugin.file}`;
}

/** A size a person can read, from the exact byte count. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
