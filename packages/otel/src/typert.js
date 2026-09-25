/**
 * Host typert artifact: discovered automatically by @deepseek-ai/dsh-typert-loader
 * through the package's "./typert" export and registered into ctx.typert, which
 * the typert gateway consults for strict dispatch codecs.
 */
import { OWN_PACKAGE, descriptorsFor } from "./descriptors.js";
import { otelErrorSchema } from "./schemas.js";

/** @param {string} pkg the npm package exporting this manifest through "./typert" */
export function typertFor(pkg) {
  return {
  package: pkg,
  face: "host",
  schemas: [
    { name: "otelError", create: () => otelErrorSchema }
  ],
  invocations: descriptorsFor(pkg),
  model: {
    events: [],
    objects: [],
    services: [
      {
        description: "OpenTelemetry observability configuration for DeepSeek Harness: store the Langfuse/OTLP endpoint and credentials, hot-restart the embedded collector pipeline, and send test traces from the Web UI settings panel.",
        summary: "OTLP/Langfuse observability reporting configuration.",
        tags: [],
        jsDoc: "/**\n * Observability reporting configuration for the Web UI.\n */",
        key: "dshOtel",
        exportName: "DshOtelService",
        members: [
          { kind: "method", name: "status", signature: "async status(request: OtelStatusRequest): Promise<OtelStatusResult>" },
          { kind: "method", name: "save", signature: "async save(request: OtelSaveRequest): Promise<OtelSaveResult>" },
          { kind: "method", name: "test", signature: "async test(request: OtelTestRequest): Promise<OtelTestResult>" },
          { kind: "method", name: "verifyRecent", signature: "async verifyRecent(request: OtelVerifyRecentRequest): Promise<OtelVerifyRecentResult>" }
        ],
        types: [
          { name: "OtelVerifyRecentRequest", declaration: "export interface OtelVerifyRecentRequest {}" },
          { name: "OtelVerifyRecentResult", declaration: "export type OtelVerifyRecentResult = OtelResult<{ message: string; allFound: boolean }>;" },
          { name: "OtelStatusRequest", declaration: "export interface OtelStatusRequest {}" },
          { name: "OtelStatusResult", declaration: "export type OtelStatusResult = OtelResult<OtelStatus>;" },
          { name: "OtelSaveRequest", declaration: "export interface OtelSaveRequest { readonly endpoint: string; readonly publicKey: string; readonly secretKey?: string; readonly enabled: boolean; readonly captureContent: boolean; }" },
          { name: "OtelSaveResult", declaration: "export type OtelSaveResult = OtelResult<OtelStatus>;" },
          { name: "OtelTestRequest", declaration: "export interface OtelTestRequest { readonly endpoint: string; readonly publicKey: string; readonly secretKey?: string; }" },
          { name: "OtelTestResult", declaration: "export type OtelTestResult = OtelResult<{ message: string; traceEndpoint: string }>;" },
          { name: "OtelStatus", declaration: "export interface OtelStatus { readonly configured: boolean; readonly enabled: boolean; readonly endpoint: string; readonly publicKey: string; readonly secretKeySet: boolean; readonly captureContent: boolean; readonly running: boolean; readonly traceEndpoint?: string; readonly lastError?: string; readonly version: string; }" },
          { name: "OtelResult", declaration: "export type OtelResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };" }
        ]
      }
    ]
  }
  };
}

export const TYPERT = typertFor(OWN_PACKAGE);

export { TYPERT as default };
