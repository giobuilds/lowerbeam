import { serveAgent } from './agentSession.js'
import type { ChildPort, ParentToChild } from './agentProtocol.js'

/**
 * Entry the main process forks for one coding run. It is a utility process:
 * the loop lives here, and the journal and the sandbox do not.
 *
 * Loaded under Node by a test, `parentPort` is absent and this does nothing.
 */
const parent = process.parentPort
if (parent) {
  const port: ChildPort = {
    postMessage: (message) => parent.postMessage(message),
    onMessage: (listener) => {
      parent.on('message', (event: { data: ParentToChild }) => listener(event.data))
    }
  }
  void serveAgent(port)
}
