import { useState } from 'react'
import type { ToolCallView } from '@shared/types.js'
import { mcpDecisions } from '@shared/mcpConfirm.js'

const LABELS: Record<string, string> = {
  web_search: 'Searched the web',
  fetch_page: 'Read a page'
}

/**
 * What the model did before answering.
 *
 * Shown collapsed: the point of the two-tier design is that the full result is
 * not the answer, and a wall of page text above every reply would bury the reply.
 * The sources stay visible, because a claim drawn from the web is worth being
 * able to check.
 */
export function ToolCalls({ calls }: { calls: ToolCallView[] }): React.JSX.Element | null {
  const [openId, setOpenId] = useState<string | null>(null)
  if (calls.length === 0) return null

  return (
    <div className="mb-2 space-y-1.5">
      {calls.map((call) => {
        const query = readQuery(call)
        const open = openId === call.id
        return (
          <div key={call.id} className="rounded border border-edge bg-ink/50 px-2 py-1.5">
            <div className="flex items-baseline gap-2 text-[11px]">
              <span className={call.ok === false ? 'text-rose-300' : 'text-violet-300'}>
                {LABELS[call.name] ?? call.name}
              </span>
              {query && <span className="min-w-0 flex-1 truncate text-slate-300">{query}</span>}
              {call.awaiting && <span className="text-amber-200">waiting for you</span>}
              {call.summary === undefined && !call.awaiting && (
                <span className="animate-pulse text-muted">working…</span>
              )}
              {call.approxTokens !== undefined && (
                <span className="shrink-0 text-muted" title="Roughly what this result cost in context">
                  ~{call.approxTokens} tokens
                </span>
              )}
              {call.content && (
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : call.id)}
                  className="shrink-0 text-muted hover:text-accent"
                >
                  {open ? 'hide' : 'show'}
                </button>
              )}
            </div>

            {call.awaiting && (
              <div className="mt-1.5">
                <p className="text-[11px] leading-snug text-slate-300">
                  This runs a tool from an MCP server. It does not run until you allow it.
                </p>
                {call.argumentsJson && call.argumentsJson !== '{}' && (
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-ink p-2 text-[11px] text-muted">
                    {formatArgs(call.argumentsJson)}
                  </pre>
                )}
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => mcpDecisions.decide(call.id, true)}
                    className="rounded border border-edge px-2 py-1 text-[11px] text-slate-200 hover:border-accent"
                  >
                    Allow
                  </button>
                  <button
                    type="button"
                    onClick={() => mcpDecisions.decide(call.id, false)}
                    className="rounded px-2 py-1 text-[11px] text-muted hover:text-slate-200"
                  >
                    Don’t run
                  </button>
                </div>
              </div>
            )}

            {call.sources && call.sources.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {call.sources.map((s) => (
                  <li key={s.url} className="truncate text-[11px]">
                    <a href={s.url} className="text-accent hover:underline" title={s.url}>
                      {s.title || s.url}
                    </a>
                  </li>
                ))}
              </ul>
            )}

            {open && call.content && (
              <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-ink p-2 text-[11px] text-muted">
                {call.content}
              </pre>
            )}
          </div>
        )
      })}
    </div>
  )
}

function formatArgs(argumentsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argumentsJson), null, 2)
  } catch {
    return argumentsJson
  }
}

function readQuery(call: ToolCallView): string {
  try {
    const args = JSON.parse(call.argumentsJson) as Record<string, unknown>
    return String(args['query'] ?? args['url'] ?? '')
  } catch {
    return ''
  }
}
