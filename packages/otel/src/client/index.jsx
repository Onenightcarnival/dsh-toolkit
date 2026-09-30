/**
 * dsh-otel browser plugin entry: mounts the dshOtel Remote contribution, then
 * registers the native Settings → Observability page where pk / sk /
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
      settingsTab: "可观测"
    },
    en: {
      settingsTab: "Observability"
    }
  });

  const t = ctx.locale.bind(NS);
  // Side cards uses order 100; place Observability immediately below it.
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "dsh-otel-settings",
        order: 110,
        label: () => t("settingsTab"),
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
