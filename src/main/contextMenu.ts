import { clipboard, ipcMain, shell, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc.js'
import { isAppSender } from './sender.js'
import type { ContextMenuCommand, ContextMenuRequest } from '@shared/types.js'

/**
 * Right-click handling.
 *
 * Chromium spell-checks editable fields and underlines mistakes on its own, but
 * the suggestions are only reachable through a menu the application provides.
 * A native menu would supply one, at the cost of dropping a platform-styled
 * window into the middle of an application that looks nothing like it. So the
 * data is forwarded to the renderer, which draws a menu in the app's own idiom;
 * the commands come back here, because replacing a misspelling and reaching the
 * clipboard both need the main process.
 */
export function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const request: ContextMenuRequest = {
      x: params.x,
      y: params.y,
      isEditable: params.isEditable,
      selectionText: params.selectionText,
      linkURL: params.linkURL,
      misspelledWord: params.misspelledWord,
      dictionarySuggestions: params.dictionarySuggestions,
      canUndo: params.editFlags.canUndo,
      canRedo: params.editFlags.canRedo,
      canCut: params.editFlags.canCut,
      canCopy: params.editFlags.canCopy,
      canPaste: params.editFlags.canPaste
    }
    win.webContents.send(IPC.contextMenuShow, request)
  })
}

/** Registered once; the window is found from the sender so it works per window. */
export function registerContextMenuCommands(): void {
  ipcMain.on(IPC.contextMenuCommand, (event, raw: ContextMenuCommand) => {
    if (!isAppSender(event)) return
    const contents = event.sender
    switch (raw?.type) {
      case 'replace-misspelling':
        contents.replaceMisspelling(raw.word)
        break
      case 'add-to-dictionary':
        contents.session.addWordToSpellCheckerDictionary(raw.word)
        break
      case 'undo': contents.undo(); break
      case 'redo': contents.redo(); break
      case 'cut': contents.cut(); break
      case 'copy': contents.copy(); break
      case 'paste': contents.paste(); break
      case 'select-all': contents.selectAll(); break
      case 'copy-text': clipboard.writeText(raw.text); break
      case 'open-external':
        // Only http(s) is opened: a context menu should not be a way to hand an
        // arbitrary scheme to the desktop.
        if (/^https?:\/\//i.test(raw.url)) void shell.openExternal(raw.url)
        break
    }
  })
}
