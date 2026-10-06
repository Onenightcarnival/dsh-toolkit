/**
 * Build-time shim for @opentelemetry/exporter-trace-otlp-proto, substituted by
 * the keepalive-shim esbuild plugin for every import outside this directory.
 *
 * - HTTP keep-alive is off: every OTLP export opens a new connection, matching the panel's test export.
 * - Export statistics (batches, spans, last result, recent traces) are recorded in `traceExportStats` for the settings panel.
 * - Langfuse session and user aliases are added to every exported span.
 */
export * from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPTraceExporter as RealOTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

const RECENT_LIMIT = 50;

export const traceExportStats = {
  batches: 0,
  spans: 0,
  lastAt: null,
  lastOk: null,
  lastError: null,
  /** Recently exported traces: [{ traceId, at, spans }], newest last. */
  recent: []
};

/**
 * Source keys for the `langfuse.session.id` / `session.id` aliases, in priority order.
 * Older Langfuse versions group sessions by the alias keys only.
 */
const SESSION_SOURCE_KEYS = ["gen_ai.session.id", "gen_ai.conversation.id", "dsh.session.id"];

function addLangfuseAliases(spans) {
  for (const span of spans) {
    const attrs = span.attributes;
    if (!attrs) continue;
    try {
      if (attrs["langfuse.session.id"] === undefined) {
        for (const key of SESSION_SOURCE_KEYS) {
          const value = attrs[key];
          if (value !== undefined && value !== null && value !== "") {
            attrs["langfuse.session.id"] = value;
            if (attrs["session.id"] === undefined) attrs["session.id"] = value;
            break;
          }
        }
      }
      if (attrs["langfuse.user.id"] === undefined && attrs["gen_ai.user.id"] !== undefined) {
        attrs["langfuse.user.id"] = attrs["gen_ai.user.id"];
      }
    } catch {}
  }
}

function recordTrace(traceId, spans) {
  const existing = traceExportStats.recent.find((e) => e.traceId === traceId);
  if (existing) {
    existing.spans += spans;
    existing.at = new Date().toISOString();
    return;
  }
  traceExportStats.recent.push({ traceId, at: new Date().toISOString(), spans });
  if (traceExportStats.recent.length > RECENT_LIMIT) traceExportStats.recent.shift();
}

export class OTLPTraceExporter extends RealOTLPTraceExporter {
  constructor(config = {}) {
    super({ keepAlive: false, ...config });
  }

  export(spans, resultCallback) {
    addLangfuseAliases(spans);
    super.export(spans, (result) => {
      traceExportStats.batches += 1;
      traceExportStats.spans += spans.length;
      traceExportStats.lastAt = new Date().toISOString();
      traceExportStats.lastOk = result.code === 0;
      traceExportStats.lastError = result.error
        ? String(result.error?.message ?? result.error).slice(0, 300)
        : null;
      if (result.code === 0) {
        const perTrace = new Map();
        for (const span of spans) {
          const id = span.spanContext().traceId;
          perTrace.set(id, (perTrace.get(id) ?? 0) + 1);
        }
        for (const [id, count] of perTrace) recordTrace(id, count);
      }
      resultCallback(result);
    });
  }
}
