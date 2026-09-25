/**
 * esbuild plugin: every importer except the shims themselves gets the
 * keep-alive-off OTLP exporters from src/otlp-shims/ in place of the proto
 * exporters, so the embedded collector and the test exporter share one
 * transport behaviour.
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
