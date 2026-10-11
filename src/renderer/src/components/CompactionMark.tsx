import { useState } from 'react'
import { unsupportedLines } from '@context/verify.js'
import type { CompactionView } from '@shared/types.js'

/**
 * Where the transcript and what the model sees part company.
 *
 * Everything above this line is still readable, and still on disk; the model is
 * given the summary instead. Saying so plainly matters — a model that seems to
 * have forgotten the start of a conversation is otherwise indistinguishable
 * from a broken one.
 */
export function CompactionMark({
  compaction,
  source
}: {
  compaction: CompactionView
  /** The turns the record replaced. A line that does not occur here is marked. */
  source: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const missing = unsupportedLines(compaction.summary, source)
  const flagged = new Set(missing)
  return (
    <div className="my-3">
      <div className="flex items-center gap-2">
        <span className="h-px flex-1 bg-edge" />
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="rounded-full border border-edge px-2.5 py-0.5 text-[11px] text-muted hover:text-slate-200"
        >
          {compaction.messageCount} earlier messages kept as a record for the model
          {missing.length > 0 && (
            <span className="text-rose-300">
              {' '}
              · {missing.length} not in the transcript
            </span>
          )}
          <span className="ml-1 opacity-60">{open ? '▾' : '▸'}</span>
        </button>
        <span className="h-px flex-1 bg-edge" />
      </div>
      {open && (
        <div className="mx-auto mt-2 max-w-2xl rounded border border-edge bg-ink/50 p-3 text-[11px] leading-relaxed text-muted">
          {compaction.summary.split('\n').map((line, index) => {
            const bad = flagged.has(line.trim())
            return (
              <span key={index} className={bad ? 'block text-rose-300' : 'block'} title={bad ? 'Not in the transcript' : undefined}>
                {line.trim() === '' ? '\u00a0' : line}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
