/**
 * Track session ids that the browser extension has driven through the bridge.
 * Desktop-native sessions keep the host userQuestions waterfall.
 * @module @onenightcarnival/dsh-bridge-browser/src/extension-sessions
 */

/** Mutable registry of extension-owned session ids. */
export class ExtensionSessionRegistry {
  private readonly ids = new Set<string>()

  /** Remember a session the extension successfully created or prompted. */
  note(sessionId: string | undefined): void {
    if (typeof sessionId === 'string' && sessionId.length > 0) this.ids.add(sessionId)
  }

  /** Whether the extension has touched this session over the bridge. */
  has(sessionId: string | undefined): boolean {
    return typeof sessionId === 'string' && this.ids.has(sessionId)
  }

  /** Test helper: drop all tracked ids. */
  clear(): void {
    this.ids.clear()
  }
}

/**
 * Whether the bridge owns ask_user_question for this request: true only for a
 * session the extension has driven while an extension connection is active.
 */
export function shouldBridgeOwnQuestion(input: {
  hasExtensionConnection: boolean
  sessionId: string | undefined
  extensionSessions: Pick<ExtensionSessionRegistry, 'has'>
}): boolean {
  return input.hasExtensionConnection
    && input.sessionId !== undefined
    && input.extensionSessions.has(input.sessionId)
}
