/** Pure-helper unit tests against the built lib/index.js. */
import assert from "node:assert/strict";
import {
  buildAuthHeaders,
  langfuseVerdict,
  isLangfuseKeyPair,
  collectorConfigFrom,
  describeTestFailure,
  isLangfuseEndpoint,
  normalizeEndpoint,
  traceSignalUrl
} from "../lib/index.js";

// normalizeEndpoint
assert.equal(normalizeEndpoint(""), "");
assert.equal(normalizeEndpoint("  "), "");
assert.equal(normalizeEndpoint("https://cloud.langfuse.com"), "https://cloud.langfuse.com/api/public/otel");
assert.equal(normalizeEndpoint("cloud.langfuse.com"), "https://cloud.langfuse.com/api/public/otel");
assert.equal(normalizeEndpoint("https://cloud.langfuse.com/"), "https://cloud.langfuse.com/api/public/otel");
assert.equal(
  normalizeEndpoint("https://cloud.langfuse.com/api/public/otel"),
  "https://cloud.langfuse.com/api/public/otel"
);
assert.equal(normalizeEndpoint("http://localhost:4318"), "http://localhost:4318");
assert.equal(normalizeEndpoint("http://localhost:4318/"), "http://localhost:4318");
assert.equal(normalizeEndpoint("my-collector.internal:4318"), "https://my-collector.internal:4318");
// Self-hosted langfuse on a langfuse-named host with explicit path is kept.
assert.equal(
  normalizeEndpoint("https://langfuse.corp.example/api/public/otel"),
  "https://langfuse.corp.example/api/public/otel"
);
// Self-hosted Langfuse on any host: the pk-lf-/sk-lf- key hint appends the path.
assert.equal(
  normalizeEndpoint("http://localhost:3000", true),
  "http://localhost:3000/api/public/otel"
);
assert.equal(normalizeEndpoint("http://localhost:3000/api/public/otel", true), "http://localhost:3000/api/public/otel");
assert.equal(normalizeEndpoint("http://localhost:4318", false), "http://localhost:4318");
// Gateway sub-path deployments: the Langfuse hint appends onto the prefix,
// the way the Langfuse SDKs treat base_url.
assert.equal(
  normalizeEndpoint("https://gateway.corp/langfuse-prod", true),
  "https://gateway.corp/langfuse-prod/api/public/otel"
);
assert.equal(
  normalizeEndpoint("https://gateway.corp/langfuse-prod/api/public/otel", true),
  "https://gateway.corp/langfuse-prod/api/public/otel"
);
// Langfuse-named host with a prefix path now also gets the append.
assert.equal(
  normalizeEndpoint("https://langfuse.corp.example/team-a"),
  "https://langfuse.corp.example/team-a/api/public/otel"
);
// Explicit signal URL is the escape hatch: kept verbatim.
assert.equal(
  normalizeEndpoint("https://gateway.corp/otlp/v1/traces", true),
  "https://gateway.corp/otlp/v1/traces"
);
assert.equal(isLangfuseKeyPair("pk-lf-4cfb", "sk-lf-5824"), true);
assert.equal(isLangfuseKeyPair("pk-lf-4cfb", ""), true);
assert.equal(isLangfuseKeyPair("", ""), false);
assert.equal(isLangfuseKeyPair("my-token", "secret"), false);

// isLangfuseEndpoint
assert.equal(isLangfuseEndpoint("https://cloud.langfuse.com/api/public/otel"), true);
assert.equal(isLangfuseEndpoint("https://observability.corp/api/public/otel"), true);
assert.equal(isLangfuseEndpoint("http://localhost:4318"), false);

// buildAuthHeaders
assert.deepEqual(buildAuthHeaders("", ""), {});
assert.deepEqual(buildAuthHeaders(undefined, undefined), {});
const headers = buildAuthHeaders("pk-lf-1", "sk-lf-2");
assert.equal(headers.authorization, `Basic ${Buffer.from("pk-lf-1:sk-lf-2").toString("base64")}`);

// traceSignalUrl
assert.equal(traceSignalUrl("http://localhost:4318"), "http://localhost:4318/v1/traces");
assert.equal(traceSignalUrl("http://localhost:4318/v1/traces"), "http://localhost:4318/v1/traces");
assert.equal(traceSignalUrl("http://localhost:4318/v1/metrics"), "http://localhost:4318/v1/traces");
assert.equal(
  traceSignalUrl("https://cloud.langfuse.com/api/public/otel"),
  "https://cloud.langfuse.com/api/public/otel/v1/traces"
);

// collectorConfigFrom
const langfuseCfg = collectorConfigFrom({
  endpoint: "https://cloud.langfuse.com",
  publicKey: "pk",
  secretKey: "sk",
  enabled: true,
  captureContent: true
});
assert.equal(langfuseCfg.endpoint, "https://cloud.langfuse.com/api/public/otel");
assert.equal(langfuseCfg.exportMetrics, false);
assert.equal(langfuseCfg.captureContent, true);
assert.ok(langfuseCfg.headers.authorization.startsWith("Basic "));

// Self-hosted Langfuse record: keys drive path completion and metric muting.
const selfHostedCfg = collectorConfigFrom({
  endpoint: "http://localhost:3000",
  publicKey: "pk-lf-4cfb",
  secretKey: "sk-lf-5824",
  enabled: true,
  captureContent: true
});
assert.equal(selfHostedCfg.endpoint, "http://localhost:3000/api/public/otel");
assert.equal(selfHostedCfg.exportMetrics, false);

const genericCfg = collectorConfigFrom({
  endpoint: "http://localhost:4318",
  publicKey: "",
  secretKey: "",
  enabled: true,
  captureContent: false
});
assert.equal(genericCfg.exportMetrics, true);
assert.deepEqual(genericCfg.headers, {});
assert.equal(genericCfg.captureContent, false);

// langfuseVerdict
{
  const ids = { control: "aaa", genai: "bbb", real: "ccc" };
  const all = langfuseVerdict({ control: "found", genai: "found", real: "found" }, ids);
  assert.equal(all.ok, true);
  assert.match(all.message, /全部测试 trace 入库/);
  assert.match(all.message, /累计导出/);
  const dropped = langfuseVerdict({ control: "found", genai: "found", real: "not-found" }, ids);
  assert.equal(dropped.ok, false);
  assert.match(dropped.message, /真实管线复刻.*丢弃/s);
  assert.match(dropped.message, /ccc/);
  const droppedBoth = langfuseVerdict({ control: "found", genai: "not-found", real: "not-found" }, ids);
  assert.equal(droppedBoth.ok, false);
  assert.match(droppedBoth.message, /GenAI 形态、真实管线复刻/);
  const unreachable = langfuseVerdict({ control: "unreachable:HTTP 404", genai: "not-found", real: "not-found" }, ids);
  assert.equal(unreachable.ok, true);
  assert.match(unreachable.message, /无法通过 Langfuse API 回查/);
  const none = langfuseVerdict({ control: "not-found", genai: "not-found", real: "not-found" }, ids);
  assert.equal(none.ok, true);
  assert.match(none.message, /worker/);
}

// describeTestFailure
assert.match(describeTestFailure("Export failed with status code 401"), /认证失败/);
assert.match(describeTestFailure("Export failed with status code 413"), /请求体过大/);
assert.match(describeTestFailure("Request Entity Too Large"), /请求体过大/);
assert.match(describeTestFailure("Export failed with status code 404"), /接口不存在/);
assert.match(describeTestFailure("getaddrinfo ENOTFOUND nope.example"), /无法连接/);
assert.equal(describeTestFailure("weird"), "weird");

// The collector config passes the embedded plugin's own schema.
const { Config } = await import("@loongsuite/dsh-plugin");
const resolved = Config(langfuseCfg);
assert.equal(resolved.endpoint, "https://cloud.langfuse.com/api/public/otel");
assert.equal(resolved.contentMaxChars, 128000);

console.log("unit tests passed");
