/**
 * Build-time shim for @opentelemetry/exporter-trace-otlp-proto, substituted
 * by scripts/build.mjs for every import outside this directory. Two jobs:
 *
 * 1. Disable HTTP keep-alive so every OTLP export opens a fresh connection —
 *    the exact transport behaviour of the panel's test button. Corporate
 *    gateways silently kill idle keep-alive sockets (often without a FIN);
 *    with the default agent the first batch after an idle gap dies on the
 *    dead socket. At batch cadence a new connection per export costs nothing.
 *
 * 2. Record live export statistics (batches, spans, last result) into a
 *    module-global the settings panel reads. After a conversation, a counter
 *    that did not move proves no export happened at all — separating "the
 *    collector produced nothing" from "the server dropped it after a 200".
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
 * Session/user attribute aliases for older Langfuse versions. The bundled
 * collector emits the modern GenAI semantic keys (gen_ai.session.id /
 * gen_ai.conversation.id); new Langfuse maps those to its session grouping,
 * but older versions only recognize langfuse.session.id / session.id — so
 * traces arrive ungrouped there. Copying the value onto the legacy keys is
 * harmless on backends that don't use them and restores session grouping on
 * the ones that do.
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
