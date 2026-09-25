/**
 * dsh-otel browser plugin entry: mounts the dshOtel Remote contribution, then
 * registers the native Settings → Plugins configuration tab where pk / sk /
 * endpoint are entered.
 */
import { createOtelApi } from "./api.js";
import { OtelSettings } from "./OtelSettings.jsx";
import { OWN_PACKAGE } from "../descriptors.js";
import { remoteFor } from "../remote.js";

const NS = "dsh-otel";

export const inject = ["remote", "slots", "locale"];

/** The client plugin for a host manifest exported by `pkg`. */
export function clientFor(pkg) {
  return { name: "dsh-otel-client", inject, apply: (ctx) => mount(ctx, remoteFor(pkg)) };
}

export function apply(ctx) {
  return mount(ctx, remoteFor(OWN_PACKAGE));
}

async function mount(ctx, remote) {
  const disposers = [];
  try {
    const dispose = await ctx.remote.$mount(remote);
    if (typeof dispose === "function") disposers.push(dispose);
  } catch (error) {
    for (const d of disposers.reverse()) await d();
    throw error;
  }

  const api = createOtelApi(ctx);

  ctx.locale.register(NS, {
    zh: {
      settingsTab: "可观测上报"
    },
    en: {
      settingsTab: "Observability"
    }
  });

  // The native configuration surface: one tab inside Settings → Plugins,
  // exactly like the dsh-ssh-ops resource tab.
  ctx.slots.inject("settings.plugins.tab", () =>
    ctx.slots.register(
      {
        name: "settings.plugins.tab",
        id: "dsh-otel-settings",
        order: 70,
        label: "可观测上报",
        locale: NS,
        inject: () => ({ api })
      },
      OtelSettings
    )
  );

  return async () => {
    for (const d of disposers.reverse()) await d();
  };
}
