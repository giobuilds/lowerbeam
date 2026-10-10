import { useState } from 'react'
import type { CompactionView } from '@shared/types.js'

/**
 * Where the transcript and what the model sees part company.
 *
 * Everything above this line is still readable, and still on disk; the model is
 * given the summary instead. Saying so plainly matters — a model that seems to
 * have forgotten the start of a conversation is otherwise indistinguishable
 * from a broken one.
 */
export function CompactionMark({ compaction }: { compaction: CompactionView }): React.JSX.Element {
  const [open, setOpen] = useState(false)
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
          <span className="ml-1 opacity-60">{open ? '▾' : '▸'}</span>
        </button>
        <span className="h-px flex-1 bg-edge" />
      </div>
      {open && (
        <p className="mx-auto mt-2 max-w-2xl whitespace-pre-wrap rounded border border-edge bg-ink/50 p-3 text-[11px] leading-relaxed text-muted">
          {compaction.summary}
        </p>
      )}
    </div>
  )
}
