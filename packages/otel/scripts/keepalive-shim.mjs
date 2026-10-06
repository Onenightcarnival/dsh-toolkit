/**
 * esbuild plugin: resolves the OTLP proto exporter imports to the keep-alive-off
 * shims in src/otlp-shims/ for every importer outside that directory.
 */
import { fileURLToPath } from "node:url";

const SHIM_DIR = fileURLToPath(new URL("../src/otlp-shims/", import.meta.url));

export const keepAliveShimPlugin = {
  name: "otlp-keepalive-shim",
  setup(pluginBuild) {
    pluginBuild.onResolve(
      { filter: /^@opentelemetry\/exporter-(?:trace|metrics)-otlp-proto$/ },
      (args) => {
        if (args.importer.includes("otlp-shims")) return undefined;
        return { path: SHIM_DIR + (args.path.includes("trace") ? "trace.js" : "metrics.js") };
      }
    );
  }
};
