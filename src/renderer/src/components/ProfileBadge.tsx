import { comparisonLine } from '@shared/sharedProfile.js'
import { useServerStore } from '../state/serverStore.js'

const ago = (ts: number): string => {
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/**
 * Shows that the current settings came from a previous working launch of this
 * model, and lets that memory be discarded. Profiles are only written after a
 * server has reached `ready`, so this is a known-good configuration rather than
 * whatever was last typed.
 */
export function ProfileBadge({ disabled }: { disabled: boolean }): React.JSX.Element | null {
  const profile = useServerStore((s) => s.profile)
  const applied = useServerStore((s) => s.profileApplied)
  const sharedCheck = useServerStore((s) => s.sharedCheck)
  const modelPath = useServerStore((s) => s.draft.modelPath)
  const forget = useServerStore((s) => s.forgetProfile)
  if (!profile) return null

  const share = (): void => {
    const got = useServerStore.getState().sharedCheck?.got ?? null
    void window.llama.profiles.share(modelPath, got).catch((err: unknown) => {
      useServerStore.setState({ error: err instanceof Error ? err.message : String(err) })
    })
  }

  return (
    <div className="rounded-md border border-emerald-900/70 bg-emerald-950/25 p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-emerald-200">
          {applied ? 'Using settings that worked before' : 'Saved settings available'}
        </span>
        <span className="flex shrink-0 items-baseline gap-2">
          <button
            type="button"
            onClick={share}
            title="Opens a GitHub issue with these numbers filled in. Nothing is sent until you submit it."
            className="text-[11px] text-muted hover:text-slate-200"
          >
            Share
          </button>
          <button
            type="button"
            onClick={() => void forget()}
            disabled={disabled}
            className="text-[11px] text-muted hover:text-rose-300 disabled:opacity-40"
          >
            Forget
          </button>
        </span>
      </div>
      {sharedCheck && (
        <p className="mt-0.5 text-[11px] leading-snug text-slate-300">{comparisonLine(sharedCheck.said, sharedCheck.got)}</p>
      )}
      <p className="mt-0.5 text-[11px] leading-snug text-muted">
        Last launched {ago(profile.lastUsedAt)}
        {profile.loadMs !== null && ` · ready in ${(profile.loadMs / 1000).toFixed(1)}s`}
        {profile.actualContext !== null &&
          ` · ${profile.actualContext.toLocaleString()} tokens of context`}
        {!applied && ' · edited since'}
      </p>
    </div>
  )
}
