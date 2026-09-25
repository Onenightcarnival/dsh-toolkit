/**
 * Invocation descriptors for the `dshOtel` Remote, shared by the host TYPERT
 * manifest (typert.js) and the client contribution (remote.js). Descriptor ids
 * carry the npm package that exports the manifest; the toolkit bundle builds
 * them under its own name.
 */
import * as S from "./schemas.js";

export const OWN_PACKAGE = "@onenightcarnival/dsh-otel";
const NS = "dshOtel";

function def(PACKAGE, method, requestSchema, requestType, resultSchema, resultType) {
  return {
    id: `${PACKAGE}#${NS}/${method}`,
    service: NS,
    namespace: NS,
    method,
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "request",
        wire: "request",
        source: "json",
        codec: { mode: "strict", typeSymbol: `${PACKAGE}/types#${requestType}`, schema: requestSchema }
      }
    ],
    result: {
      mode: "strict",
      typeSymbol: `${PACKAGE}/types#${resultType}`,
      schema: resultSchema
    },
    sourceLocation: { file: "src/index.js", line: 1, column: 1 }
  };
}

/** @param {string} pkg the npm package exporting the manifest */
export function descriptorsFor(pkg) {
  return [
    def(pkg, "status", S.statusRequestSchema, "OtelStatusRequest", S.statusResultSchema, "OtelStatusResult"),
    def(pkg, "save", S.saveRequestSchema, "OtelSaveRequest", S.saveResultSchema, "OtelSaveResult"),
    def(pkg, "test", S.testRequestSchema, "OtelTestRequest", S.testResultSchema, "OtelTestResult"),
    def(pkg, "verifyRecent", S.verifyRecentRequestSchema, "OtelVerifyRecentRequest", S.verifyRecentResultSchema, "OtelVerifyRecentResult")
  ];
}

export const DESCRIPTORS = descriptorsFor(OWN_PACKAGE);
