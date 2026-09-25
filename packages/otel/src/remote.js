/**
 * Client typert contribution, mounted by the browser plugin through
 * ctx.remote.$mount(contribution). Built from the same descriptors as the host
 * manifest, under the same package name.
 */
import { OWN_PACKAGE, descriptorsFor } from "./descriptors.js";

/** @param {string} pkg the npm package that exports the host manifest */
export function remoteFor(pkg) {
  return { package: pkg, descriptors: descriptorsFor(pkg) };
}

export const TYPERT_REMOTE = remoteFor(OWN_PACKAGE);

export { TYPERT_REMOTE as default };
