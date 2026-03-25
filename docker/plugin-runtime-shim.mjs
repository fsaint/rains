// Shim for missing plugin runtime module.
export function createPluginRuntime(_options = {}) {
  return {
    version: "reins-shim",
    config: {},
    system: {},
    media: {},
    tools: {},
    channel: {},
    events: {},
    logging: {},
    state: {},
    modelAuth: {},
  };
}
