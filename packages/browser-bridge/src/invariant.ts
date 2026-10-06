/**
 * Package-owned invariant companion for `@onenightcarnival/dsh-bridge-browser`.
 * @module @onenightcarnival/dsh-bridge-browser/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@onenightcarnival/dsh-bridge-browser'

/** Cordis companion plugin name. */
export const name = 'bridge-browser-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Installs no runtime invariant. The wire contract is verified by the
 * `protocol.ts` unit tests; tool registrations are observed by the dsh-tools
 * invariant.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
