/**
 * Service: `dshOtel`, exposed through Typert Remote.
 * Storage: Langfuse/OTLP configuration in the DSH storage domain.
 * Collector: bundled Apache-2.0 @loongsuite/dsh-plugin; hot-restarted on save.
 * Diagnostics: real OTLP exports, payload probes and conversation traces.
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import { context, diag, DiagLogLevel, trace } from "@opentelemetry/api";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import * as collectorPlugin from "@loongsuite/dsh-plugin";
// Diagnostics use the collector's span mapping, resolved by file path at build time.
import { createTelemetryPipeline } from "../node_modules/@loongsuite/dsh-plugin/dist/telemetry.js";
import { DshTraceCoordinator } from "../node_modules/@loongsuite/dsh-plugin/dist/coordinator.js";
// Export statistics share the collector's exporter shim instance.
import { traceExportStats } from "./otlp-shims/trace.js";

export const PLUGIN_VERSION = "0.7.2";

const CONFIG_KEY = "default";
const TEST_TIMEOUT_MS = 15000;

const configRecordSchema = z.object({
  endpoint: z.string(),
  publicKey: z.string(),
  secretKey: z.string(),
  enabled: z.boolean(),
  captureContent: z.boolean(),
  // Legacy configuration records may omit these fields.
  gzip: z.boolean().optional(),
  contentMaxChars: z.number().optional(),
  maxExportBatchSize: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const DEFAULT_CONTENT_MAX_CHARS = 128_000;
export const DEFAULT_MAX_EXPORT_BATCH_SIZE = 512;

/** Sized to trip typical gateway body caps (nginx client_max_body_size 1m). */
const PAYLOAD_TEST_BYTES = 900 * 1024;

/**
 * OTLP exporters read compression variables at construction.
 * Gzip-enabled collectors retain these values until stop, then restore them.
 */
const COMPRESSION_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_COMPRESSION",
  "OTEL_EXPORTER_OTLP_TRACES_COMPRESSION",
  "OTEL_EXPORTER_OTLP_METRICS_COMPRESSION"
];

const configDomainSpec = defineDomain({
  name: "dsh_otel",
  version: 1,
  tables: {
    config: domainTable(configRecordSchema)
  }
});

function fail(code, message) {
  return { code, message };
}

// ── pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Langfuse API keys carry stable prefixes (pk-lf-… / sk-lf-…), which makes
 * them a hostname-independent signal — self-hosted instances on any domain
 * (localhost included) are recognized through the keys alone.
 */
export function isLangfuseKeyPair(publicKey, secretKey) {
  return /^pk-lf-/i.test(String(publicKey ?? "").trim())
    || /^sk-lf-/i.test(String(secretKey ?? "").trim());
}

/**
 * Normalize a user-pasted endpoint. Adds https:// when the scheme is missing,
 * strips trailing slashes, and — when the host looks like Langfuse or the
 * caller passes a Langfuse hint (pk-lf-/sk-lf- keys) — appends the
 * `/api/public/otel` OTLP base path the way the Langfuse SDKs do: onto
 * whatever base URL was given, gateway path prefixes included
 * (e.g. https://gateway.corp/langfuse → …/langfuse/api/public/otel).
 * A URL already ending in /api/public/otel, or pinned to an explicit signal
 * path (/v1/traces, /v1/metrics), is kept as-is — the signal form is also
 * the escape hatch when the auto-append is not wanted.
 */
export function normalizeEndpoint(raw, langfuseHint = false) {
  let value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (value === "") return "";
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "");
    const langfuse = langfuseHint || /langfuse/i.test(url.hostname);
    const hasOtelBase = /\/api\/public\/otel$/i.test(path);
    const isSignalUrl = /\/v1\/(?:traces|metrics)$/i.test(path);
    if (langfuse && !hasOtelBase && !isSignalUrl) {
      url.pathname = `${path}/api/public/otel`;
      return url.toString().replace(/\/+$/, "");
    }
    return value;
  } catch {
    return value;
  }
}

/** Langfuse ingests OTLP traces but not OTLP metrics; detect to mute metrics. */
export function isLangfuseEndpoint(endpoint) {
  return /langfuse/i.test(endpoint) || /\/api\/public\/otel\b/i.test(endpoint);
}

/** Basic auth header from a Langfuse-style pk/sk pair; empty when unset. */
export function buildAuthHeaders(publicKey, secretKey) {
  const pk = String(publicKey ?? "").trim();
  const sk = String(secretKey ?? "").trim();
  if (pk === "" && sk === "") return {};
  const token = Buffer.from(`${pk}:${sk}`, "utf8").toString("base64");
  return { authorization: `Basic ${token}` };
}

/** Append the OTLP trace signal path unless the URL already names a signal. */
export function traceSignalUrl(endpoint) {
  const trimmed = String(endpoint ?? "").replace(/\/+$/, "");
  if (/\/v1\/(?:traces|metrics)$/i.test(trimmed)) {
    return trimmed.replace(/\/v1\/(?:traces|metrics)$/i, "/v1/traces");
  }
  return `${trimmed}/v1/traces`;
}

/** Map a stored config record onto the embedded collector's config shape. */
export function collectorConfigFrom(record) {
  const endpoint = normalizeEndpoint(
    record.endpoint,
    isLangfuseKeyPair(record.publicKey, record.secretKey)
  );
  return {
    enabled: true,
    endpoint,
    headers: buildAuthHeaders(record.publicKey, record.secretKey),
    captureContent: record.captureContent,
    // Metrics are enabled only for generic OTLP backends; Langfuse accepts traces.
    exportMetrics: !isLangfuseEndpoint(endpoint),
    ...record.contentMaxChars === undefined ? {} : { contentMaxChars: record.contentMaxChars },
    ...record.maxExportBatchSize === undefined ? {} : { maxExportBatchSize: record.maxExportBatchSize }
  };
}

/** Trace IDs produced by the test actions, so read-backs can label them. */
export const testTraceIds = new Set();

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(label)), ms);
      timer.unref?.();
    })
  ]);
}

/**
 * Send one real span through a throwaway OTLP pipeline and report the export
 * result. On success the backend shows a trace named "dsh-otel connection
 * test", which doubles as visible confirmation in Langfuse.
 */
export async function runTestExport({ endpoint, headers, gzip = false, payloadBytes = 0, genai = false }, exporterFactory) {
  const url = traceSignalUrl(endpoint);
  const makeExporter = exporterFactory
    ?? (() => new OTLPTraceExporter({
      url,
      headers,
      timeoutMillis: 20000,
      ...gzip ? { compression: "gzip" } : {}
    }));
  const exporter = makeExporter(url);
  let capture = null;
  const wrapper = {
    export(spans, resultCallback) {
      exporter.export(spans, (result) => {
        capture = result;
        resultCallback(result);
      });
    },
    shutdown: () => exporter.shutdown(),
    forceFlush: () => Promise.resolve()
  };
  const provider = new BasicTracerProvider({
    resource: defaultResource().merge(resourceFromAttributes({
      "service.name": "dsh-otel",
      "dsh.plugin": "dsh-otel"
    })),
    spanProcessors: [new SimpleSpanProcessor(wrapper)]
  });
  let traceId = null;
  try {
    const tracer = provider.getTracer("dsh-otel");
    if (genai) {
      // GenAI probe: ENTRY root and LLM child with collector-compatible attributes.
      const messagesIn = JSON.stringify([{ role: "user", parts: [{ type: "text", content: "Hello" }] }]);
      const messagesOut = JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: "Hello!" }] }]);
      const entry = tracer.startSpan("dsh-otel genai test", {
        attributes: {
          "gen_ai.span.kind": "ENTRY",
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": "deepseek-official",
          "gen_ai.conversation.id": "dsh-otel-genai-test",
          "gen_ai.input.messages": messagesIn,
          "gen_ai.output.messages": messagesOut
        }
      });
      traceId = entry.spanContext().traceId;
      const parentCtx = trace.setSpan(context.active(), entry);
      const llm = tracer.startSpan("chat deepseek-chat", {
        attributes: {
          "gen_ai.span.kind": "LLM",
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": "deepseek-official",
          "gen_ai.request.model": "deepseek-chat",
          "gen_ai.response.model": "deepseek-chat",
          "gen_ai.usage.input_tokens": 5,
          "gen_ai.usage.output_tokens": 3,
          "gen_ai.usage.total_tokens": 8,
          "gen_ai.input.messages": messagesIn,
          "gen_ai.output.messages": messagesOut
        }
      }, parentCtx);
      llm.end();
      entry.end();
    } else {
      const span = tracer.startSpan(
        payloadBytes > 0 ? "dsh-otel payload test" : "dsh-otel connection test"
      );
      traceId = span.spanContext().traceId;
      span.setAttribute("dsh.otel.test", true);
      if (payloadBytes > 0) {
        // Incompressible content keeps the gzip wire size near payloadBytes.
        span.setAttribute(
          "dsh.otel.test.payload",
          randomBytes(Math.ceil((payloadBytes * 3) / 4)).toString("base64")
        );
      }
      span.end();
    }
    await withTimeout(provider.forceFlush(), TEST_TIMEOUT_MS, "export timed out");
  } catch (error) {
    // forceFlush failures return the same { ok, message } result as export failures.
    if (capture === null) {
      const first = Array.isArray(error) ? error[0] : error;
      capture = { code: 1, error: first };
    }
  } finally {
    await provider.shutdown().catch(() => {});
  }
  if (traceId !== null) testTraceIds.add(traceId);
  // ExportResultCode.SUCCESS === 0 in @opentelemetry/core.
  if (capture !== null && capture.code === 0) {
    return { ok: true, traceEndpoint: url, traceId };
  }
  const message = capture?.error?.message ?? String(capture?.error ?? "export did not complete in time");
  return { ok: false, traceEndpoint: url, traceId, message };
}

/**
 * Query Langfuse persistence with the configured Basic auth credentials.
 * Returns found, not-found or unreachable:<detail> independently of OTLP acceptance.
 */
export async function checkLangfuseTrace(endpoint, headers, traceId, fetchImpl = fetch) {
  const apiBase = String(endpoint).replace(/\/api\/public\/otel$/i, "");
  const url = `${apiBase}/api/public/traces/${traceId}`;
  try {
    const response = await fetchImpl(url, {
      headers: { ...headers, accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });
    if (response.status === 200) return "found";
    if (response.status === 404) return "not-found";
    return `unreachable:HTTP ${response.status}`;
  } catch (error) {
    return `unreachable:${String(error?.message ?? error)}`;
  }
}

/**
 * Poll the Langfuse API for a set of labelled test traces until all are found
 * or the attempts run out (ingestion is asynchronous and can lag by many
 * seconds). `ids` maps label → traceId; the result maps label → state.
 */
export async function verifyLangfuseTraces(endpoint, headers, ids, options = {}) {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? 4000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const states = Object.fromEntries(Object.keys(ids).map((k) => [k, "not-found"]));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    for (const [label, traceId] of Object.entries(ids)) {
      if (states[label] !== "found") {
        states[label] = await checkLangfuseTrace(endpoint, headers, traceId, fetchImpl);
      }
    }
    const values = Object.values(states);
    if (values.every((s) => s === "found")) break;
    if (values.every((s) => s.startsWith("unreachable"))) break;
  }
  return states;
}

const TRACE_LABELS = {
  control: "Control",
  genai: "GenAI",
  real: "Collector pipeline"
};

/** Turn the per-trace verification states into an operator-facing verdict. */
export function langfuseVerdict(states, ids) {
  const idLine = `（trace ID：${Object.entries(ids)
    .map(([k, v]) => `${TRACE_LABELS[k] ?? k}=${v}`)
    .join(", ")}）`;
  const labels = Object.keys(states);
  const found = labels.filter((k) => states[k] === "found");
  const missing = labels.filter((k) => states[k] === "not-found");
  const unreachable = labels.filter((k) => states[k].startsWith("unreachable"));

  if (found.length === labels.length) {
    return {
      ok: true,
      message: ("All test traces were stored. " + String(idLine) + "")
    };
  }
  if (found.length === 0 && unreachable.length > 0) {
    const detail = states[unreachable[0]].replace("unreachable:", "");
    return {
      ok: true,
      message: ("Export succeeded; Langfuse lookup failed: " + String(detail) + ". " + String(idLine) + "")
    };
  }
  if (states.control === "found" && missing.length > 0) {
    const missingLabels = missing.map((k) => TRACE_LABELS[k] ?? k).join(", ");
    return {
      ok: false,
      message: ("Control trace stored; " + String(missingLabels) + " exported but not found. " + String(idLine) + "")
    };
  }
  if (found.length === 0) {
    return {
      ok: true,
      message: ("Export succeeded; traces not found yet. Query by trace ID later. " + String(idLine) + "")
    };
  }
  return {
    ok: true,
    message: ("Incomplete lookup results: " + String(labels.map((k) => `${TRACE_LABELS[k] ?? k}=${states[k]}`).join(", ")) + ".")
      + idLine
  };
}

/**
 * Export a synthetic turn through DshTraceCoordinator and createTelemetryPipeline.
 * Includes resource attributes, gen_ai.* fields and ENTRY→AGENT→STEP→LLM spans
 * in one batch to the configured backend.
 */
export async function runRealPipelineTest({ endpoint, headers, gzip = false }) {
  const url = traceSignalUrl(endpoint);
  const real = new OTLPTraceExporter({
    url,
    headers,
    timeoutMillis: 20000,
    ...gzip ? { compression: "gzip" } : {}
  });
  const traceIds = new Set();
  let spanCount = 0;
  let capture = null;
  const wrapper = {
    export(spans, resultCallback) {
      spanCount += spans.length;
      for (const span of spans) traceIds.add(span.spanContext().traceId);
      real.export(spans, (result) => {
        capture = result;
        resultCallback(result);
      });
    },
    shutdown: () => real.shutdown(),
    forceFlush: () => Promise.resolve()
  };
  const cfg = {
    ...collectorPlugin.Config({ enabled: true, endpoint, headers }),
    captureContent: true,
    exportMetrics: false
  };
  const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
  const pipeline = createTelemetryPipeline(cfg, { traceExporter: wrapper });
  try {
    const coordinator = new DshTraceCoordinator(pipeline.handler, cfg, silentLogger);
    const now = Date.now();
    const sessionId = `dsh-otel-real-test-${now}`;
    const sess = {
      id: sessionId,
      header: { id: sessionId, createdAt: now - 1000, cwd: "/", agentPreset: "default" },
      firstLiveSeq: 0,
      events: []
    };
    const evt = (type, data, seq, time) => ({ type, data, seq, time });
    const t0 = now - 800;
    let seq = 0;
    coordinator.adoptSession(sess);
    coordinator.onSessionEvent(sess, evt("turn/start", { turn: 1 }, seq++, t0));
    coordinator.onSessionEvent(sess, evt(
      "user/message",
      { id: "u1", role: "user", content: [{ type: "text", text: "Hello (dsh-otel collector pipeline test)" }], source: { kind: "user" } },
      seq++, t0 + 10
    ));
    coordinator.onSessionEvent(sess, evt("step/start", { turn: 1, step: 1 }, seq++, t0 + 20));
    const llmOptions = {
      provider: "deepseek-official",
      model: "deepseek-chat",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "Hello" }], source: { kind: "user" } }],
      system: "You are a helpful assistant.",
      sessionId
    };
    const fakeStream = () => (async function* () {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "Hello" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "Hello!" } };
      yield { type: "usage", usage: { inputTokens: 8, outputTokens: 3 } };
      yield { type: "finish", reason: { kind: "stop" } };
    })();
    for await (const chunk of coordinator.interceptLlm(llmOptions, fakeStream)) void chunk;
    coordinator.onSessionEvent(sess, evt(
      "assistant/message",
      {
        turn: 1,
        step: 1,
        message: { id: "a1", role: "assistant", content: [{ type: "text", text: "Hello!" }], source: { kind: "model", provider: "deepseek-official", model: "deepseek-chat" } }
      },
      seq++, t0 + 300
    ));
    coordinator.onSessionEvent(sess, evt("step/end", { turn: 1, step: 1 }, seq++, t0 + 400));
    coordinator.onSessionEvent(sess, evt("turn/end", { turn: 1, reason: { kind: "completed" } }, seq++, t0 + 500));
    await withTimeout(pipeline.forceFlush(), TEST_TIMEOUT_MS, "export timed out");
  } catch (error) {
    if (capture === null) {
      const first = Array.isArray(error) ? error[0] : error;
      capture = { code: 1, error: first };
    }
  } finally {
    await pipeline.shutdown().catch(() => {});
  }
  for (const id of traceIds) testTraceIds.add(id);
  if (capture !== null && capture.code === 0) {
    return { ok: true, traceEndpoint: url, traceId: [...traceIds][0] ?? null, spanCount };
  }
  const message = capture?.error?.message ?? String(capture?.error ?? "export did not complete in time");
  return { ok: false, traceEndpoint: url, traceId: [...traceIds][0] ?? null, spanCount, message };
}

/** Translate raw exporter failures into actionable operator guidance. */
export function describeTestFailure(message) {
  if (/status code 413|Payload Too Large|Request Entity Too Large/i.test(message)) {
    return ("Payload too large: " + String(message) + ". Enable gzip or reduce the content limit.");
  }
  if (/status code 401|status code 403|Unauthorized|Forbidden/i.test(message)) {
    return ("Authentication failed: " + String(message) + ". Check project credentials.");
  }
  if (/status code 404/i.test(message)) {
    return ("Endpoint not found: " + String(message) + ". Check the endpoint and gateway path.");
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timed out|socket hang up/i.test(message)) {
    return ("Connection failed: " + String(message) + ". Check the address, network and proxy.");
  }
  return message;
}

// ── service ─────────────────────────────────────────────────────────────────

/**
 * DshOtelService: one cordis service (and Typert Remote) that owns the
 * observability configuration and the embedded collector lifecycle.
 */
export default class DshOtelService extends TypertRemoteService {
  static inject = ["storageDomain"];

  configTable = null;
  collectorScope = null;
  lastError = null;
  /** Most recent export failure seen through the OTel diag bridge. */
  lastExportError = null;
  /** Benign transport note (e.g. non-compliant success responses). */
  lastExportNote = null;
  /** Saved pre-existing compression env values while gzip is forced on. */
  savedCompressionEnv = null;
  /** Resolved trace endpoint of the running collector, for the status line. */
  activeTraceEndpoint = null;

  constructor(ctx, config = {}) {
    super(ctx, "dshOtel");
    this.config = config;
    ctx.effect(() => () => {
      this.stopCollector();
    }, "dsh-otel: stop embedded collector");
  }

  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(configDomainSpec);
    this.configTable = domain.table("config");
    this.ctx.effect(() => () => domain.close(), "dsh-otel: config domain close");
    this.attachDiagBridge();
    const record = this.loadRecord();
    if (record) this.applyCollector(record);
    this.ctx.logger.info(
      `[dsh-otel] loaded; configured=${record !== null}; reporting=${this.collectorScope !== null ? "on" : "off"}`
    );
  }

  /**
   * Forward OTel diagnostics to the dsh logger and retain the latest failure
   * for the settings panel.
   */
  attachDiagBridge() {
    const note = (args) => {
      try {
        const text = args
          .map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a)))
          .join(" ")
          .slice(0, 400);
        // Benign: the export itself succeeded but the server answered with a
        // non-compliant body instead of an OTLP protobuf response — old
        // Langfuse versions return their async ingestion-job JSON here. Not a
        // delivery failure; keep it as an informational note only.
        if (/Export succeeded but could not deserialize response/i.test(text)) {
          this.lastExportNote = ("" + String(new Date().toISOString()) + " Server returned a non-OTLP response body. ")
            + "Older Langfuse versions may return asynchronous task JSON. Export succeeded. "
            + "No action required.";
          return;
        }
        this.lastExportError = `${new Date().toISOString()} ${text}`;
        this.ctx.logger.warn(`[dsh-otel] otel export issue: ${text}`);
      } catch {}
    };
    diag.setLogger(
      {
        verbose() {},
        debug() {},
        info() {},
        warn: (...args) => note(args),
        error: (...args) => note(args)
      },
      { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true }
    );
    this.ctx.effect(() => () => diag.disable(), "dsh-otel: detach otel diag bridge");
  }

  applyCompressionEnv(gzip) {
    if (gzip) {
      if (this.savedCompressionEnv === null) {
        this.savedCompressionEnv = COMPRESSION_ENV_KEYS.map((k) => [k, process.env[k]]);
      }
      process.env.OTEL_EXPORTER_OTLP_COMPRESSION = "gzip";
    } else {
      this.restoreCompressionEnv();
    }
  }

  restoreCompressionEnv() {
    if (this.savedCompressionEnv === null) return;
    for (const [key, value] of this.savedCompressionEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    this.savedCompressionEnv = null;
  }

  loadRecord() {
    const raw = this.configTable?.get(CONFIG_KEY);
    if (raw === undefined || raw === null) return null;
    const parsed = configRecordSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  stopCollector() {
    const scope = this.collectorScope;
    this.collectorScope = null;
    this.activeTraceEndpoint = null;
    this.restoreCompressionEnv();
    if (scope !== null) {
      try {
        scope.dispose();
      } catch (error) {
        this.ctx.logger.warn(`[dsh-otel] failed to dispose collector: ${String(error)}`);
      }
    }
  }

  applyCollector(record) {
    this.stopCollector();
    this.lastError = null;
    this.lastExportError = null;
    if (!record.enabled || record.endpoint.trim() === "") return;
    try {
      // The exporters read the compression env at construction, inside the
      // collector's apply; keep it applied for the collector's lifetime.
      this.applyCompressionEnv(record.gzip === true);
      const raw = collectorConfigFrom(record);
      // Resolve schema defaults explicitly so the collector's apply() always
      // sees a complete config even if the runtime skips schema resolution.
      const resolved = collectorPlugin.Config(raw);
      this.collectorScope = this.ctx.plugin(collectorPlugin, resolved);
      this.activeTraceEndpoint = traceSignalUrl(raw.endpoint);
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.ctx.logger.warn(`[dsh-otel] failed to start collector: ${this.lastError}`);
    }
  }

  statusValue() {
    const record = this.loadRecord();
    const value = {
      configured: record !== null,
      enabled: record?.enabled ?? false,
      endpoint: record?.endpoint ?? "",
      publicKey: record?.publicKey ?? "",
      secretKeySet: (record?.secretKey ?? "") !== "",
      captureContent: record?.captureContent ?? true,
      gzip: record?.gzip ?? false,
      contentMaxChars: record?.contentMaxChars ?? DEFAULT_CONTENT_MAX_CHARS,
      maxExportBatchSize: record?.maxExportBatchSize ?? DEFAULT_MAX_EXPORT_BATCH_SIZE,
      running: this.collectorScope !== null,
      exportedBatches: traceExportStats.batches,
      exportedSpans: traceExportStats.spans,
      version: PLUGIN_VERSION
    };
    // Strict Typert results must be JSON-safe: optional fields must be
    // absent, rather than present with an `undefined` value.
    if (this.activeTraceEndpoint !== null) value.traceEndpoint = this.activeTraceEndpoint;
    if (this.lastError !== null) value.lastError = this.lastError;
    if (this.lastExportError !== null) value.lastExportError = this.lastExportError;
    if (this.lastExportNote !== null) value.lastExportNote = this.lastExportNote;
    if (traceExportStats.lastAt !== null) value.lastExportAt = traceExportStats.lastAt;
    if (traceExportStats.lastOk !== null) value.lastExportOk = traceExportStats.lastOk;
    return value;
  }

  // ── Remote methods ─────────────────────────────────────────────────────────

  async status() {
    try {
      return { ok: true, value: this.statusValue() };
    } catch (error) {
      return { ok: false, error: fail("status-failed", String(error?.message ?? error)) };
    }
  }

  async save(request) {
    try {
      const table = this.configTable;
      if (table === null) {
        return { ok: false, error: fail("not-ready", "Configuration storage is not ready. Try again later.") };
      }
      const previous = this.loadRecord();
      const secretKey = request.secretKey !== undefined
        ? request.secretKey.trim()
        : previous?.secretKey ?? "";
      const endpoint = normalizeEndpoint(
        request.endpoint,
        isLangfuseKeyPair(request.publicKey, secretKey)
      );
      if (request.enabled && endpoint === "") {
        return { ok: false, error: fail("endpoint-required", "An endpoint is required to enable reporting.") };
      }
      const now = new Date().toISOString();
      const record = {
        endpoint,
        publicKey: request.publicKey.trim(),
        secretKey,
        enabled: request.enabled,
        captureContent: request.captureContent,
        // Absent advanced fields mean "use the collector default" and clear
        // any stored override — the panel always sends its full form state.
        ...request.gzip === undefined ? {} : { gzip: request.gzip },
        ...request.contentMaxChars === undefined ? {} : { contentMaxChars: request.contentMaxChars },
        ...request.maxExportBatchSize === undefined ? {} : { maxExportBatchSize: request.maxExportBatchSize },
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      };
      await table.put(CONFIG_KEY, record);
      this.applyCollector(record);
      return { ok: true, value: this.statusValue() };
    } catch (error) {
      return { ok: false, error: fail("save-failed", String(error?.message ?? error)) };
    }
  }

  async test(request) {
    try {
      const record = this.loadRecord();
      const secretKey = request.secretKey !== undefined
        ? request.secretKey.trim()
        : record?.secretKey ?? "";
      const endpoint = normalizeEndpoint(
        request.endpoint,
        isLangfuseKeyPair(request.publicKey, secretKey)
      );
      if (endpoint === "") {
        return { ok: false, error: fail("endpoint-required", "Enter an endpoint first.") };
      }
      const headers = buildAuthHeaders(request.publicKey, secretKey);
      const gzip = request.gzip ?? record?.gzip ?? false;

      // Stage 1: connectivity and auth with a tiny span.
      const small = await runTestExport({ endpoint, headers, gzip });
      if (!small.ok) {
        return {
          ok: false,
          error: fail(
            "test-failed",
            ("" + String(describeTestFailure(small.message)) + " (request URL: " + String(small.traceEndpoint) + ")")
          )
        };
      }

      // Stage 2: ~900 KB payload probe for gateway body-size limits.
      const large = await runTestExport({ endpoint, headers, gzip, payloadBytes: PAYLOAD_TEST_BYTES });
      if (!large.ok) {
        return {
          ok: false,
          error: fail(
            "payload-limit",
            ("Payload test failed (about 900 KB): " + String(describeTestFailure(large.message)) + "")
              + (" (request URL: " + String(large.traceEndpoint) + ")")
          )
        };
      }

      // Stage 3: GenAI trace with API read-back to verify asynchronous ingestion.
      const genaiTest = await runTestExport({ endpoint, headers, gzip, genai: true });
      if (!genaiTest.ok) {
        return {
          ok: false,
          error: fail(
            "genai-rejected",
            ("GenAI test failed: " + String(describeTestFailure(genaiTest.message)) + "")
              + (" (request URL: " + String(genaiTest.traceEndpoint) + ")")
          )
        };
      }

      // Stage 4: full conversation through the collector's mapping pipeline.
      const realTest = await runRealPipelineTest({ endpoint, headers, gzip });
      if (!realTest.ok) {
        return {
          ok: false,
          error: fail(
            "real-pipeline-failed",
            ("Collector pipeline test failed (" + String(realTest.spanCount) + " spans): " + String(describeTestFailure(realTest.message)) + "")
              + (" (request URL: " + String(realTest.traceEndpoint) + ")")
          )
        };
      }

      const baseLine = ("Tests passed: connectivity, 900 KB payload, GenAI, collector pipeline (" + String(realTest.spanCount) + " spans" + String(gzip ? ", gzip" : "") + "). ");

      if (isLangfuseEndpoint(endpoint)) {
        const ids = { control: small.traceId, genai: genaiTest.traceId, real: realTest.traceId };
        const verification = await verifyLangfuseTraces(endpoint, headers, ids);
        const verdict = langfuseVerdict(verification, ids);
        if (!verdict.ok) {
          return { ok: false, error: fail("server-side-drop", `${baseLine}${verdict.message}`) };
        }
        return { ok: true, value: { message: `${baseLine}${verdict.message}`, traceEndpoint: small.traceEndpoint } };
      }

      return {
        ok: true,
        value: {
          message: baseLine,
          traceEndpoint: small.traceEndpoint
        }
      };
    } catch (error) {
      return { ok: false, error: fail("test-failed", describeTestFailure(String(error?.message ?? error))) };
    }
  }

  /**
   * Query Langfuse persistence for recent conversation and test traces.
   */
  async verifyRecent() {
    try {
      const record = this.loadRecord();
      if (record === null) {
        return { ok: false, error: fail("not-configured", "Save the configuration first.") };
      }
      const endpoint = normalizeEndpoint(
        record.endpoint,
        isLangfuseKeyPair(record.publicKey, record.secretKey)
      );
      if (!isLangfuseEndpoint(endpoint)) {
        return { ok: false, error: fail("not-langfuse", "This backend does not support trace lookup. Check the receiving platform.") };
      }
      const recent = [...traceExportStats.recent].slice(-8).reverse();
      if (recent.length === 0) {
        return { ok: false, error: fail("no-exports", "No exports yet. Send a test or complete a conversation turn.") };
      }
      const headers = buildAuthHeaders(record.publicKey, record.secretKey);
      const states = new Map();
      for (const entry of recent) {
        states.set(entry.traceId, await checkLangfuseTrace(endpoint, headers, entry.traceId));
      }
      if ([...states.values()].some((s) => s === "not-found")) {
        // Fresh traces may still be in the async ingestion queue; one retry.
        await sleep(5000);
        for (const entry of recent) {
          if (states.get(entry.traceId) === "not-found") {
            states.set(entry.traceId, await checkLangfuseTrace(endpoint, headers, entry.traceId));
          }
        }
      }
      const describe = { "found": "Stored", "not-found": "Not found" };
      const lines = recent.map((entry) => {
        const state = states.get(entry.traceId);
        const label = testTraceIds.has(entry.traceId) ? "Test" : "Conversation";
        const time = entry.at.replace("T", " ").slice(5, 19);
        const verdictText = describe[state] ?? ("Lookup unavailable (" + String(state.replace("unreachable:", "")) + ")");
        return `${label} ${time} ${entry.spans}span ${entry.traceId} → ${verdictText}`;
      });
      const missing = recent.filter((e) => states.get(e.traceId) === "not-found");
      const allFound = missing.length === 0;
      const summary = allFound
        ? ("Lookup results for the latest " + String(recent.length) + " traces:")
        : ("Of the latest " + String(recent.length) + " traces, " + String(missing.length) + " were not found:");
      return { ok: true, value: { message: `${summary}\n${lines.join("\n")}`, allFound } };
    } catch (error) {
      return { ok: false, error: fail("verify-failed", String(error?.message ?? error)) };
    }
  }
}
