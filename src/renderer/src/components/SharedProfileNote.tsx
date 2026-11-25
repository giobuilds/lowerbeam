import { useServerStore } from '../state/serverStore.js'

/**
 * A shared profile is a starting point, or only a suggestion.
 * It is hidden once this machine has its own measurement. That measurement
 * is the emerald badge beside this note.
 */
export function SharedProfileNote(): React.JSX.Element | null {
  const shared = useServerStore((s) => s.shared)
  const applied = useServerStore((s) => s.sharedApplied)
  const profile = useServerStore((s) => s.profile)
  if (!shared || profile) return null
  const edited = shared.kind !== 'loose' && !applied

  return (
    <div className="rounded-md border border-edge bg-ink/60 p-2.5">
      <p className="text-[11px] font-medium leading-snug text-slate-200">
        {shared.summary}
        {edited ? ' Edited since.' : ''}
      </p>
      {shared.buildWarning && (
        <p className="mt-0.5 text-[11px] leading-snug text-amber-300">{shared.buildWarning}</p>
      )}
      {shared.driverNote && <p className="mt-0.5 text-[11px] leading-snug text-muted">{shared.driverNote}</p>}
    </div>
  )
}
