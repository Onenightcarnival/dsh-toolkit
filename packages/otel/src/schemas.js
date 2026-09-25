/**
 * Zod schemas for the dsh-otel wire contract. Bundled into both faces: the
 * host typert manifest validates incoming args and outgoing results, and the
 * client contribution validates the same envelope on the browser side.
 */
import { z } from "zod";

export const otelErrorSchema = z.object({
  code: z.string(),
  message: z.string()
});

export function okSchema(value) {
  return z.object({ ok: z.literal(true), value });
}

export function resultSchema(value) {
  return z.union([
    okSchema(value),
    z.object({ ok: z.literal(false), error: otelErrorSchema })
  ]);
}

// ── status ──────────────────────────────────────────────────────────────────

export const statusRequestSchema = z.object({});

export const statusValueSchema = z.object({
  /** A configuration record has been saved at least once. */
  configured: z.boolean(),
  enabled: z.boolean(),
  endpoint: z.string(),
  publicKey: z.string(),
  /** The secret key is stored host-side; it is never echoed back. */
  secretKeySet: z.boolean(),
  captureContent: z.boolean(),
  /** gzip-compress OTLP request bodies (helps with gateway body-size caps). */
  gzip: z.boolean(),
  /** Effective per-attribute content truncation (chars). */
  contentMaxChars: z.number(),
  /** Effective max spans per exported batch. */
  maxExportBatchSize: z.number(),
  /** The collector pipeline is currently mounted. */
  running: z.boolean(),
  /** Resolved OTLP trace endpoint of the running collector, when known. */
  traceEndpoint: z.string().optional(),
  /** Last collector start error, when the pipeline failed to mount. */
  lastError: z.string().optional(),
  /** Most recent export failure observed from the running collector. */
  lastExportError: z.string().optional(),
  /** Benign transport note (e.g. non-compliant success responses). */
  lastExportNote: z.string().optional(),
  /** Cumulative OTLP export batches since process start (tests included). */
  exportedBatches: z.number(),
  /** Cumulative spans exported since process start (tests included). */
  exportedSpans: z.number(),
  /** Timestamp of the most recent export attempt. */
  lastExportAt: z.string().optional(),
  /** Whether the most recent export attempt succeeded. */
  lastExportOk: z.boolean().optional(),
  version: z.string()
});

export const statusResultSchema = resultSchema(statusValueSchema);

// ── save ────────────────────────────────────────────────────────────────────

export const saveRequestSchema = z.object({
  endpoint: z.string(),
  publicKey: z.string(),
  /** Absent = keep the stored secret; present = replace it (empty clears). */
  secretKey: z.string().optional(),
  enabled: z.boolean(),
  captureContent: z.boolean(),
  /** Absent = off. */
  gzip: z.boolean().optional(),
  /** Absent = collector default (128000). */
  contentMaxChars: z.number().int().min(100).max(10_000_000).optional(),
  /** Absent = collector default (512). */
  maxExportBatchSize: z.number().int().min(1).max(4096).optional()
});

export const saveResultSchema = resultSchema(statusValueSchema);

// ── test ────────────────────────────────────────────────────────────────────

export const testRequestSchema = z.object({
  endpoint: z.string(),
  publicKey: z.string(),
  /** Absent = use the stored secret key. */
  secretKey: z.string().optional(),
  /** Absent = use the stored gzip setting. */
  gzip: z.boolean().optional()
});

export const testResultSchema = resultSchema(
  z.object({
    message: z.string(),
    traceEndpoint: z.string()
  })
);

// ── verifyRecent ────────────────────────────────────────────────────────────

export const verifyRecentRequestSchema = z.object({});

export const verifyRecentResultSchema = resultSchema(
  z.object({
    message: z.string(),
    allFound: z.boolean()
  })
);
