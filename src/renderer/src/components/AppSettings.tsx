import { useEffect, useState } from 'react'
import type { ThemeChoice } from '@shared/theme.js'

/**
 * Settings for the app itself.
 *
 * One page, opened from the File menu. Appearance is the first section.
 * Later choices go here as further sections, not as new windows.
 */
export function AppSettings({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-edge bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center border-b border-edge px-4 py-2.5">
          <div>
            <h2 className="text-sm font-semibold">Settings</h2>
            <p className="text-[11px] text-muted">Choices for this app, kept on this machine</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-xs text-muted hover:text-slate-200"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <Appearance />
        </div>
      </div>
    </div>
  )
}

const APPEARANCE: { choice: ThemeChoice; label: string; hint: string }[] = [
  { choice: 'system', label: 'Follow the system', hint: 'Use the desktop’s light or dark setting.' },
  { choice: 'light', label: 'Light', hint: 'Light colours, whatever the desktop is using.' },
  { choice: 'dark', label: 'Dark', hint: 'The dark colours, whatever the desktop is using.' }
]

function Appearance(): React.JSX.Element {
  const [theme, setTheme] = useState<ThemeChoice>('system')
  const [error, setError] = useState('')

  useEffect(() => {
    void window.llama.settings.theme().then(setTheme).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
    })
  }, [])

  const choose = (choice: ThemeChoice): void => {
    setTheme(choice)
    setError('')
    void window.llama.settings.setTheme(choice).then(setTheme).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
    })
  }

  return (
    <section className="rounded border border-edge bg-ink/40 p-3">
      <h3 className="text-xs font-semibold text-slate-200">Appearance</h3>
      <fieldset className="mt-2 space-y-2">
        <legend className="sr-only">Appearance</legend>
        {APPEARANCE.map((option) => (
          <label key={option.choice} className="flex cursor-pointer items-start gap-2">
            <input
              type="radio"
              name="appearance"
              className="mt-0.5"
              checked={theme === option.choice}
              onChange={() => choose(option.choice)}
            />
            <span>
              <span className="block text-sm text-slate-100">{option.label}</span>
              <span className="block text-[11px] text-muted">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {error && <p className="mt-2 text-[11px] text-rose-200">{error}</p>}
    </section>
  )
}
