/**
 * Browser-side client for the `dshOtel` Remote namespace. The namespace
 * service is mounted by apply() through ctx.remote.$mount(TYPERT_REMOTE);
 * this class unwraps the { ok, value | error } envelope into values or
 * thrown errors.
 */
export class OtelApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OtelApiError";
    this.code = code;
  }
}

export class OtelApi {
  /** @param {() => object|undefined} getNamespace live namespace getter */
  constructor(getNamespace) {
    this.getNamespace = getNamespace;
  }

  async call(method, args) {
    const namespace = this.getNamespace();
    const fn = namespace?.[method];
    if (typeof fn !== "function") {
      throw new OtelApiError("not-mounted", `dshOtel Remote method "${method}" is not mounted`);
    }
    const rpc = await fn(args);
    if (!rpc.ok) {
      throw new OtelApiError("rpc-failed", rpc.error?.message ?? "remote call failed");
    }
    const business = rpc.value;
    if (business.ok) return business.value;
    throw new OtelApiError(business.error.code, business.error.message);
  }

  status() {
    return this.call("status", {});
  }

  save(input) {
    return this.call("save", input);
  }

  test(input) {
    return this.call("test", input);
  }

  verifyRecent() {
    return this.call("verifyRecent", {});
  }
}

export function createOtelApi(ctx) {
  return new OtelApi(() => {
    const remote = ctx.remote;
    return remote?.namespaces?.get("dshOtel")?.service;
  });
}
