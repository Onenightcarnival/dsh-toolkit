/**
 * Integration test on a real @deepseek-ai/cordis Context with stubbed DSH
 * services: mounts DshOtelService, saves a config through the Remote surface,
 * asserts the embedded collector starts and actually exports a session's
 * trace to a local OTLP stub, then flips config and asserts hot-restart.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import DshOtelService from "../lib/index.js";

// ── local OTLP stub backend ─────────────────────────────────────────────────
const posts = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    posts.push({ url: req.url, auth: req.headers.authorization, bytes: Buffer.concat(chunks).length });
    res.statusCode = 200;
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;

// ── cordis context with stubbed DSH services ────────────────────────────────
const ctx = new Context();

const logs = [];
const mkLogger = () => ({
  info: (...a) => logs.push(["info", a.join(" ")]),
  warn: (...a) => logs.push(["warn", a.join(" ")]),
  error: (...a) => logs.push(["error", a.join(" ")]),
  debug: () => {}
});
if (!ctx.logger) ctx.provide("logger", mkLogger());

// storageDomain stub: in-memory tables with the get/put/delete surface used.
const stores = new Map();
ctx.provide("storageDomain", {
  async open(spec) {
    const domainTables = new Map();
    for (const name of Object.keys(spec.tables ?? {})) {
      const key = `${spec.name}/${name}`;
      if (!stores.has(key)) stores.set(key, new Map());
      const map = stores.get(key);
      domainTables.set(name, {
        get: (id) => map.get(id),
        put: async (id, record) => void map.set(id, record),
        delete: async (id) => void map.delete(id)
      });
    }
    return { table: (name) => domainTables.get(name), close: () => {} };
  }
});

// sessions/llm stubs so the embedded collector's inject is satisfied. The
// collector calls sessions.list() at apply time, so the call count proves the
// inner plugin actually mounted rather than parking on unresolved inject.
let sessionsListCalls = 0;
ctx.provide("sessions", { list: () => { sessionsListCalls += 1; return []; } });
ctx.provide("llm", {});

// ── mount the service ───────────────────────────────────────────────────────
ctx.plugin(DshOtelService);
await ctx.start?.();
await new Promise((resolve) => setTimeout(resolve, 300));

const service = ctx.get ? ctx.get("dshOtel") : ctx.dshOtel;
assert.ok(service, "dshOtel service registered");

// Initially unconfigured.
let status = await service.status();
assert.equal(status.ok, true);
assert.equal(status.value.configured, false);
assert.equal(status.value.running, false);

// Save a config → collector starts against the stub backend.
const saved = await service.save({
  endpoint,
  publicKey: "pk-test",
  secretKey: "sk-test",
  enabled: true,
  captureContent: true
});
assert.equal(saved.ok, true, JSON.stringify(saved));
assert.equal(saved.value.running, true, `collector should run: ${JSON.stringify(saved.value)}; logs=${JSON.stringify(logs)}`);
assert.equal(saved.value.secretKeySet, true);
assert.equal(saved.value.traceEndpoint, `${endpoint}/v1/traces`);

// The embedded collector actually applied (it enumerates sessions on apply).
await new Promise((resolve) => setTimeout(resolve, 200));
assert.ok(sessionsListCalls >= 1, "embedded collector should have enumerated sessions on apply");

// Drive one real conversation turn through the embedded collector: emit the
// native DSH session events the coordinator subscribes to, then wait past
// the 5s batch interval and assert the session trace reached the stub at the
// SAME /v1/traces URL the panel test uses — the real-reporting URL and the
// test URL are one code path.
{
  const before = posts.length;
  const sess = {
    id: "session-int",
    header: { id: "session-int", createdAt: Date.now() - 1000, cwd: "/tmp/p", agentPreset: "default" },
    firstLiveSeq: 0,
    events: []
  };
  const started = Date.now() - 500;
  const evt = (type, data, seq, time) => ({ type, data, seq, time });
  ctx.emit("session/created", sess);
  ctx.emit("session/event", sess, evt("turn/start", { turn: 1 }, 0, started));
  ctx.emit("session/event", sess, evt(
    "user/message",
    { id: "u1", role: "user", content: [{ type: "text", text: "你好" }], source: { kind: "user" } },
    1, started + 10
  ));
  ctx.emit("session/event", sess, evt("step/start", { turn: 1, step: 1 }, 2, started + 20));
  ctx.emit("session/event", sess, evt("step/end", { turn: 1, step: 1 }, 3, started + 30));
  ctx.emit("session/event", sess, evt("turn/end", { turn: 1, reason: { kind: "completed" } }, 4, started + 40));
  await new Promise((resolve) => setTimeout(resolve, 6500));
  assert.ok(posts.length > before, "embedded collector should have exported the session trace");
  const sessionPost = posts.at(-1);
  assert.equal(sessionPost.url, "/v1/traces", "real reporting must hit the same signal URL as the test");
  assert.equal(sessionPost.auth, `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`);
  assert.ok(sessionPost.bytes > 100, `session trace should carry spans: ${sessionPost.bytes}`);
}

// Second save with sk omitted keeps the stored secret.
const resaved = await service.save({
  endpoint,
  publicKey: "pk-test",
  enabled: true,
  captureContent: false
});
assert.equal(resaved.ok, true);
assert.equal(resaved.value.secretKeySet, true);
assert.equal(resaved.value.running, true);

// Disable → collector unmounts.
const disabled = await service.save({
  endpoint,
  publicKey: "pk-test",
  enabled: false,
  captureContent: false
});
assert.equal(disabled.ok, true);
assert.equal(disabled.value.running, false);

// Test action exports one span end to end (Basic pk-test:sk-test retained).
const tested = await service.test({ endpoint, publicKey: "pk-test" });
assert.equal(tested.ok, true, JSON.stringify(tested));
await new Promise((resolve) => setTimeout(resolve, 200));
assert.ok(posts.length >= 1, "OTLP stub should have received the test trace");
assert.equal(posts.at(-1).url, "/v1/traces");
assert.equal(posts.at(-1).auth, `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`);
assert.ok(posts.at(-1).bytes > 50);

// Enabled-but-empty endpoint is rejected.
const rejected = await service.save({ endpoint: "", publicKey: "", enabled: true, captureContent: true });
assert.equal(rejected.ok, false);
assert.equal(rejected.error.code, "endpoint-required");

server.close();
await ctx.stop?.();
console.log("service integration tests passed");
process.exit(0);
