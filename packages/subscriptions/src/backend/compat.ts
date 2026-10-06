/**
 * Single-build compatibility with both published dsh lines.
 *
 * `@deepseek-ai/dsh-llm` exports the tool-call id brand as `ToolCallId` on one
 * line and `CallId` on the other; a namespace import with a runtime lookup
 * serves both. `RpcResult` is mirrored structurally instead of being imported
 * from either line's package.
 */

import * as llm from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** The branded tool-call id of whichever dsh-llm line is installed. */
export type ToolCallId = Extract<ContentBlock, { type: 'tool-call' }>['id']

/** Brand a string as a tool-call id with whichever constructor the installed dsh-llm exports. */
export const ToolCallId: (id: string) => ToolCallId = (() => {
  const exports = llm as Record<string, unknown>
  return (exports['ToolCallId'] ?? exports['CallId']) as (id: string) => ToolCallId
})()

/** Structural mirror of the connection RPC result shared by both dsh lines. */
export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details: object } }
