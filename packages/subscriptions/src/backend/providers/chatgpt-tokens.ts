import { AccountTokenManager } from './accounts.js'
import type { ChatGptSession } from '../auth/store.js'
import { withChatGptLock } from '../auth/chatgpt-lock.js'

/** Token rotation and its durable write occupy the same cross-process transaction. */
export class ChatGptTokenManager extends AccountTokenManager<ChatGptSession> {
  override async session(account?: string, forceRefresh = false): Promise<ChatGptSession> {
    const key = account ?? await this.defaultAccount()
    const before = await this.peek(key)
    return withChatGptLock('sessions', async () => {
      const current = await this.peek(key)
      const alreadyRefreshed = before !== undefined && current !== undefined && before.accessToken !== current.accessToken
      return super.session(key, forceRefresh && !alreadyRefreshed)
    })
  }
}
