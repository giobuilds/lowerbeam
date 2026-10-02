import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Who may call the bridge: the app's own page, in the app's own window, as
 * its top frame. Nothing else that ever holds `ipcRenderer` — a frame inside
 * the page, a window opened from it, the page after a navigation away — is
 * served. Today the sandboxed renderer, the CSP and DOMPurify mean nothing
 * else should get that far; this is the check that holds if one of them does
 * not, since several channels run a command or a binary on the machine.
 */

const dirname = fileURLToPath(new URL('.', import.meta.url))

/** The app's page in a build. The main process is one bundle, so this is beside it. */
export const APP_INDEX_PATH = join(dirname, '../renderer/index.html')

/**
 * Whether a URL is the app itself: the dev server's origin in development,
 * and in a build the one file the window loads — not any `file://` page,
 * which a link or a drop could otherwise make the window treat as the app.
 * The fragment and query are the page's own business and are ignored.
 */
export function isAppUrl(url: string, dev = process.env['ELECTRON_RENDERER_URL'], index = pathToFileURL(APP_INDEX_PATH).href): boolean {
  let at: URL
  try {
    at = new URL(url)
  } catch {
    return false
  }
  if (dev) {
    try {
      return at.origin === new URL(dev).origin
    } catch {
      return false
    }
  }
  if (at.protocol !== 'file:') return false
  at.hash = ''
  at.search = ''
  return at.href === new URL(index).href
}

const appContents = new Set<number>()

/** The app's own windows, by their web contents; forgotten when one closes. */
export function trustWindow(win: BrowserWindow): void {
  const id = win.webContents.id
  appContents.add(id)
  win.on('closed', () => appContents.delete(id))
}

/** Whether an IPC message came from the app's page, in one of its windows, from the top frame. */
export function isAppSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const frame = event.senderFrame
  if (!frame || frame.parent !== null) return false
  return appContents.has(event.sender.id) && isAppUrl(frame.url)
}
