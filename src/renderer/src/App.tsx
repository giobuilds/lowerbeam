import { useEffect, useState } from 'react'
import { LaunchPanel } from './views/LaunchPanel.js'
import { LogPane } from './views/LogPane.js'
import { Chat } from './views/Chat.js'
import { Downloads } from './views/Downloads.js'
import { Tuning } from './views/Tuning.js'
import { Coding } from './views/Coding.js'
import { subscribeToMain, useServerStore } from './state/serverStore.js'
import { useChatStore } from './state/chatStore.js'
import { subscribeToDownloads, useDownloadStore } from './state/downloadStore.js'
import { subscribeToBench } from './state/benchStore.js'
import { FlagReference } from './components/FlagReference.js'
import { ContextMenu } from './components/ContextMenu.js'
import { ToolSettings } from './components/ToolSettings.js'
import { About } from './components/About.js'
import { ReaderPanel } from './components/ReaderPanel.js'
import { subscribeToReader, useReaderStore } from './state/readerStore.js'
import { subscribeToCoding } from './state/codingStore.js'
import { isWebUrl } from '@shared/url.js'
import { StatusBadge } from './components/StatusBadge.js'

type Tab = 'chat' | 'server' | 'models' | 'tuning' | 'coding'

export default function App(): React.JSX.Element {
  const init = useServerStore((s) => s.init)
  const status = useServerStore((s) => s.status)
  const [tab, setTab] = useState<Tab>('chat')
  const [showFlags, setShowFlags] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const [showAbout, setShowAbout] = useState(false)

  const activeDownloads = useDownloadStore(
    (s) => s.jobs.filter((j) => j.state === 'running' || j.state === 'queued').length
  )

  useEffect(() => {
    void init()
    const offServer = subscribeToMain()
    const offDownloads = subscribeToDownloads()
    const offBench = subscribeToBench()
    const offReader = subscribeToReader()
    const offCoding = subscribeToCoding()

    // The menu does not act on the app directly; it asks the UI to do the same
    // things its buttons do, so there is one path to every action.
    const offMenu = window.llama.menu.onAction((action) => {
      switch (action) {
        case 'tab:chat': setTab('chat'); break
        case 'tab:server': setTab('server'); break
        case 'tab:models': setTab('models'); break
        case 'tab:tuning': setTab('tuning'); break
        case 'tab:coding': setTab('coding'); break
        case 'help:flags': setShowFlags(true); break
        case 'tools:configure': setShowTools(true); break
        case 'help:about': setShowAbout(true); break
        case 'chat:new':
          setTab('chat')
          void useChatStore.getState().create()
          break
        case 'server:start': void useServerStore.getState().start(); break
        case 'server:stop': void useServerStore.getState().stop(); break
        case 'server:verify':
          setTab('server')
          void useServerStore.getState().runHealthCheck()
          break
        case 'models:rescan': void useServerStore.getState().loadModels(true); break
        case 'models:add-folder': void useServerStore.getState().addModelDir(); break
      }
    })

    return () => {
      offServer()
      offDownloads()
      offBench()
      offReader()
      offCoding()
      offMenu()
    }
  }, [init])

  // Every link in the app goes to the reading pane. The main process refuses a
  // remote navigation anyway; this is what makes the refusal useful rather than
  // just a dead click.
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      const link = (event.target as HTMLElement | null)?.closest?.('a[href]')
      const href = link?.getAttribute('href') ?? ''
      if (!isWebUrl(href)) return
      event.preventDefault()
      // Holding a modifier means "not here", the same as it does in a browser.
      // Some links say so themselves: a repo or an issue tracker is worth
      // opening where you are signed in, not in a pane with an empty session.
      if (
        link?.getAttribute('data-external') === 'true' ||
        event.ctrlKey ||
        event.metaKey ||
        event.button === 1
      ) {
        void window.llama.reader.openExternal(href)
      } else {
        void useReaderStore.getState().openUrl(href)
      }
    }
    // Capture, not bubble: a modal stops propagation on its own clicks before
    // they reach the document, so a link inside one would otherwise fall
    // through to the main process's refusal instead of being handled here.
    document.addEventListener('click', onClick, true)
    document.addEventListener('auxclick', onClick, true)
    return () => {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('auxclick', onClick, true)
    }
  }, [])

  // The pane draws over the window, so it has to stand down for a modal.
  useEffect(() => {
    useReaderStore.getState().setHidden(showFlags || showTools || showAbout)
  }, [showFlags, showTools, showAbout])

  // A reply is persisted when it finishes, so closing mid-generation would drop
  // whatever had streamed. Flush what is in flight before the window goes.
  useEffect(() => {
    const onUnload = (): void => {
      const chat = useChatStore.getState()
      chat.stopAll()
      void chat.flushInFlight()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <nav className="flex items-center gap-1 border-b border-edge bg-panel px-3 py-1.5">
        <TabButton active={tab === 'chat'} onClick={() => setTab('chat')}>
          Chat
        </TabButton>
        <TabButton active={tab === 'coding'} onClick={() => setTab('coding')}>
          Coding
        </TabButton>
        <TabButton active={tab === 'server'} onClick={() => setTab('server')}>
          Server
        </TabButton>
        <TabButton active={tab === 'models'} onClick={() => setTab('models')}>
          Models
          {activeDownloads > 0 && (
            <span className="ml-1.5 rounded-full bg-accent px-1.5 text-[10px] text-ink">
              {activeDownloads}
            </span>
          )}
        </TabButton>
        <TabButton active={tab === 'tuning'} onClick={() => setTab('tuning')}>
          Tuning
        </TabButton>

        <div className="ml-auto flex items-center gap-3 text-[11px] text-muted">
          {status?.phase === 'ready' && status.config?.modelPath && (
            <span className="max-w-[22rem] truncate" title={status.config.modelPath}>
              {status.config.modelPath.split('/').pop()}
            </span>
          )}
          {status?.modalities?.vision && (
            <span
              title="This model can read images"
              className="rounded bg-violet-900/50 px-1.5 py-0.5 text-[10px] text-violet-200"
            >
              vision
            </span>
          )}
          <StatusBadge phase={status?.phase ?? 'stopped'} />
        </div>
      </nav>

      <main className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
        {tab === 'chat' ? (
          <Chat onConfigureTools={() => setShowTools(true)} />
        ) : tab === 'models' ? (
          <Downloads />
        ) : tab === 'tuning' ? (
          <Tuning />
        ) : tab === 'coding' ? (
          <Coding />
        ) : (
          <div className="flex h-full">
            <LaunchPanel />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-4 border-b border-edge px-4 py-2 text-xs text-muted">
                {status?.loadStage && <span className="text-amber-200">{status.loadStage}…</span>}
                {status?.phase === 'ready' && status.port && (
                  <span>
                    listening on <code className="text-slate-300">127.0.0.1:{status.port}</code>
                  </span>
                )}
                {status?.pid && <span>pid {status.pid}</span>}
              </div>
              <LogPane />
            </div>
          </div>
        )}
        </div>
        <ReaderPanel />
      </main>

      {showFlags && <FlagReference onClose={() => setShowFlags(false)} />}
      {showTools && <ToolSettings onClose={() => setShowTools(false)} />}
      {showAbout && <About onClose={() => setShowAbout(false)} />}
      <ContextMenu />
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
        active ? 'bg-ink text-slate-100' : 'text-muted hover:text-slate-200'
      }`}
    >
      {children}
    </button>
  )
}
