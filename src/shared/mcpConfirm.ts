/**
 * Chat asks before it runs a tool from an MCP server.
 *
 * Built-in search and page fetch stay immediate. A coding run does not use
 * this: it states a grant up front and does not ask mid-run.
 */

export type ToolSource = 'builtin' | 'mcp'

/** Whether this call has to wait for the person. A name the list no longer has still asks when it carries a server prefix. */
export function isMcpTool(name: string, tools: Array<{ name: string; source?: ToolSource }>): boolean {
  const found = tools.find((tool) => tool.name === name)
  if (found?.source === 'builtin') return false
  if (found?.source === 'mcp') return true
  return name.includes('__')
}

/** What the model is told when the person refuses, so the reply can finish. */
export function declinedMcpCall(name: string): { ok: false; summary: string; content: string } {
  return {
    ok: false,
    summary: 'Not run',
    content: `The person declined the call to ${name}. Do not call it again unless they ask.`
  }
}

/**
 * The main process refuses an MCP call that did not come through the prompt.
 * The renderer sets `confirmed` only after Allow.
 */
export function unconfirmedMcpCall(name: string): { ok: false; summary: string; content: string } {
  return {
    ok: false,
    summary: 'Not run',
    content: `The call to ${name} was not confirmed, so it was not run.`
  }
}

/** One prompt at a time, settled by a click or by the reply being stopped. */
export function createMcpDecisions(): {
  ask(id: string, signal: AbortSignal): Promise<boolean>
  decide(id: string, allow: boolean): void
} {
  const pending = new Map<string, (allow: boolean) => void>()
  return {
    ask(id, signal) {
      return new Promise((resolve) => {
        let settled = false
        const finish = (allow: boolean): void => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          pending.delete(id)
          resolve(allow)
        }
        const onAbort = (): void => finish(false)
        if (signal.aborted) {
          finish(false)
          return
        }
        pending.set(id, finish)
        signal.addEventListener('abort', onAbort)
      })
    },
    decide(id, allow) {
      pending.get(id)?.(allow)
    }
  }
}

/** The prompt the chat loop and the tool card share. */
export const mcpDecisions = createMcpDecisions()
