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
  /** Filename inside `frontend/public/downloads/`. */
  file: string;
  /** Exact byte count, so the UI never has to guess at a size. */
  bytes: number;
  /** One line on what installing it does. */
  summary: string;
}

export const PLUGIN_DOWNLOADS: PluginDownload[] = [
  {
    id: 'chatgpt',
    client: 'ChatGPT',
    version: '0.2.0',
    file: 'helm-chatgpt-0.2.0.zip',
    bytes: 9470,
    summary: 'Connects ChatGPT to the discovery endpoint and adds the Helm session skills.',
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
