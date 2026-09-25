/**
 * End-to-end test of the test-export path against a local OTLP stub:
 * asserts a real protobuf POST with Basic auth reaches /v1/traces, and that
 * auth/connectivity failures surface as actionable messages.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildAuthHeaders, checkLangfuseTrace, describeTestFailure, runRealPipelineTest, runTestExport, verifyLangfuseTraces } from "../lib/index.js";

const received = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    received.push({
      url: req.url,
      auth: req.headers.authorization,
      contentType: req.headers["content-type"],
      encoding: req.headers["content-encoding"],
      connection: req.headers.connection,
      bytes: body.length,
      hasLegacySession: body.includes("langfuse.session.id")
    });
    if (req.headers.authorization !== `Basic ${Buffer.from("pk:sk").toString("base64")}`) {
      res.statusCode = 401;
      res.end("unauthorized");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/x-protobuf");
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const endpoint = `http://127.0.0.1:${port}`;

// Success path.
const ok = await runTestExport({ endpoint, headers: buildAuthHeaders("pk", "sk") });
assert.equal(ok.ok, true, JSON.stringify(ok));
assert.equal(ok.traceEndpoint, `${endpoint}/v1/traces`);
assert.equal(received.length, 1);
assert.equal(received[0].url, "/v1/traces");
assert.match(received[0].contentType, /application\/x-protobuf/);
assert.ok(received[0].bytes > 50, "expected a non-trivial protobuf payload");
// The keep-alive-off shim must be active: every export dials a fresh
// connection and announces Connection: close, matching the test button.
assert.equal(received[0].connection, "close", "exports must not reuse keep-alive sockets");

// Payload test with gzip: the stub must see a gzip body of substantial size.
const big = await runTestExport({ endpoint, headers: buildAuthHeaders("pk", "sk"), gzip: true, payloadBytes: 900 * 1024 });
assert.equal(big.ok, true, JSON.stringify(big));
assert.equal(received.at(-1).encoding, "gzip");
assert.ok(received.at(-1).bytes > 400 * 1024, `gzip payload should stay large (incompressible): ${received.at(-1).bytes}`);

// GenAI-shaped export: two spans, returns the traceId for API read-back.
const genai = await runTestExport({ endpoint, headers: buildAuthHeaders("pk", "sk"), genai: true });
assert.equal(genai.ok, true, JSON.stringify(genai));
assert.match(genai.traceId, /^[0-9a-f]{32}$/);
assert.ok(received.at(-1).bytes > 400, "genai trace should carry two attribute-rich spans");

// Langfuse API read-back against a stub: control trace exists, genai does not.
{
  const api = createServer((req, res) => {
    if (req.url === `/api/public/traces/${"c".repeat(32)}`) { res.statusCode = 200; res.end("{}"); }
    else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const apiEndpoint = `http://127.0.0.1:${api.address().port}/api/public/otel`;
  assert.equal(await checkLangfuseTrace(apiEndpoint, {}, "c".repeat(32)), "found");
  assert.equal(await checkLangfuseTrace(apiEndpoint, {}, "d".repeat(32)), "not-found");
  const states = await verifyLangfuseTraces(apiEndpoint, {}, { control: "c".repeat(32), genai: "d".repeat(32) }, { attempts: 2, delayMs: 50 });
  assert.deepEqual(states, { control: "found", genai: "not-found" });
  api.close();
}

// Real-pipeline replica: the collector's own coordinator + pipeline drives a
// synthetic turn; expect one batched multi-span export with gen_ai content.
const realReplica = await runRealPipelineTest({ endpoint, headers: buildAuthHeaders("pk", "sk") });
assert.equal(realReplica.ok, true, JSON.stringify(realReplica));
assert.match(realReplica.traceId, /^[0-9a-f]{32}$/);
assert.ok(realReplica.spanCount >= 4, `expected ENTRY/AGENT/STEP/LLM spans, got ${realReplica.spanCount}`);
assert.ok(received.at(-1).bytes > 1500, `real replica batch should be attribute-rich: ${received.at(-1).bytes}`);
// Legacy Langfuse session alias must ride along on the wire, so old
// versions that only map langfuse.session.id still group sessions.
assert.equal(received.at(-1).hasLegacySession, true, "expected langfuse.session.id alias in the exported batch");

// Auth failure path.
const bad = await runTestExport({ endpoint, headers: buildAuthHeaders("pk", "wrong") });
assert.equal(bad.ok, false);
assert.match(describeTestFailure(bad.message), /认证失败|401/);

// Gateway body-size cap: a second stub rejects bodies over 500KB with 413,
// the way nginx client_max_body_size does. The small test passes, the
// payload test must surface the cap.
{
  const capped = createServer((req, res) => {
    let size = 0;
    req.on("data", (c) => { size += c.length; });
    req.on("end", () => {
      if (size > 500 * 1024) { res.statusCode = 413; res.end("Request Entity Too Large"); }
      else { res.statusCode = 200; res.end(); }
    });
  });
  await new Promise((resolve) => capped.listen(0, "127.0.0.1", resolve));
  const cappedEndpoint = `http://127.0.0.1:${capped.address().port}`;
  const smallOk = await runTestExport({ endpoint: cappedEndpoint, headers: {} });
  assert.equal(smallOk.ok, true);
  const bigRejected = await runTestExport({ endpoint: cappedEndpoint, headers: {}, gzip: true, payloadBytes: 900 * 1024 });
  assert.equal(bigRejected.ok, false);
  assert.match(describeTestFailure(bigRejected.message), /请求体过大|413/);
  capped.close();
}

// Connectivity failure path (nothing listens on the next port).
server.close();
const dead = await runTestExport({ endpoint, headers: {} });
assert.equal(dead.ok, false);
assert.match(describeTestFailure(dead.message), /无法连接|ECONNREFUSED|超时|timed out/i);

console.log("export e2e tests passed");
