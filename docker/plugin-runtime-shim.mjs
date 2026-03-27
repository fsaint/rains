// Shim for missing plugin runtime module.
// The entrypoint.sh patches this file at container startup with the correct
// import path after discovering which bundle contains createPluginRuntime.
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
