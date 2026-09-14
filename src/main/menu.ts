import { app, Menu, shell, BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { IPC } from '@shared/ipc.js'
import type { ServerSupervisor } from './supervisor.js'

/**
 * The application menu.
 *
 * Electron's default menu is written for a generic web wrapper: its Help points
 * at electronjs.org and its Edit menu offers clipboard operations that mean
 * nothing here. This replaces it with the things this app can actually do, and
 * puts the two references a user of llama.cpp actually needs — the flags of the
 * binary they have installed, and this project's issue tracker — one click away.
 */

const REPO = 'https://github.com/giobuilds/lowerbeam'
const LLAMA_CPP = 'https://github.com/ggml-org/llama.cpp'

/** Menu items act by asking the renderer to do the thing the UI already does. */
function send(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function buildAppMenu(supervisor: () => ServerSupervisor | null): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        {
          label: 'New Chat',
          accelerator: 'CmdOrCtrl+N',
          click: () => send(IPC.menuAction, 'chat:new')
        },
        { type: 'separator' },
        {
          label: 'Add Model Folder…',
          click: () => send(IPC.menuAction, 'models:add-folder')
        },
        {
          label: 'Rescan Model Library',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => send(IPC.menuAction, 'models:rescan')
        },
        { type: 'separator' },
        {
          label: 'Tools and MCP Servers…',
          click: () => send(IPC.menuAction, 'tools:configure')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: '&Server',
      submenu: [
        {
          label: 'Start Server',
          accelerator: 'CmdOrCtrl+Return',
          click: () => send(IPC.menuAction, 'server:start')
        },
        {
          label: 'Stop Server',
          accelerator: 'CmdOrCtrl+.',
          click: () => send(IPC.menuAction, 'server:stop')
        },
        { type: 'separator' },
        {
          label: 'Verify Binary',
          click: () => send(IPC.menuAction, 'server:verify')
        },
        {
          // The stock llama.cpp UI is deliberately never disabled, so it stays
          // available as an escape hatch when this app misbehaves.
          label: "Open llama.cpp's Own Web UI",
          click: () => {
            const url = supervisor()?.baseUrl
            if (url) void shell.openExternal(url)
          }
        }
      ]
    },
    {
      label: '&View',
      submenu: [
        { label: 'Chat', accelerator: 'CmdOrCtrl+1', click: () => send(IPC.menuAction, 'tab:chat') },
        { label: 'Coding', accelerator: 'CmdOrCtrl+2', click: () => send(IPC.menuAction, 'tab:coding') },
        { label: 'Server', accelerator: 'CmdOrCtrl+3', click: () => send(IPC.menuAction, 'tab:server') },
        { label: 'Models', accelerator: 'CmdOrCtrl+4', click: () => send(IPC.menuAction, 'tab:models') },
        { label: 'Tuning', accelerator: 'CmdOrCtrl+5', click: () => send(IPC.menuAction, 'tab:tuning') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
        { role: 'reload' }
      ]
    },
    { label: '&Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    {
      label: '&Help',
      submenu: [
        {
          label: 'llama.cpp Flag Reference…',
          accelerator: 'F1',
          click: () => send(IPC.menuAction, 'help:flags')
        },
        {
          label: 'llama.cpp Documentation',
          click: () => void shell.openExternal(`${LLAMA_CPP}/tree/master/docs`)
        },
        {
          label: 'llama-server README',
          click: () => void shell.openExternal(`${LLAMA_CPP}/blob/master/tools/server/README.md`)
        },
        { type: 'separator' },
        {
          label: 'Report an Issue…',
          click: () => void shell.openExternal(`${REPO}/issues/new`)
        },
        {
          label: 'Search Issues',
          click: () => void shell.openExternal(`${REPO}/issues`)
        },
        {
          label: 'View Source',
          click: () => void shell.openExternal(REPO)
        },
        { type: 'separator' },
        {
          label: `About ${app.getName()}`,
          click: () => send(IPC.menuAction, 'help:about')
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
