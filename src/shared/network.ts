/**
 * What the window says about the app's own network requests.
 *
 * Loopback to llama.cpp, a link the person opens, and an MCP server they
 * enable are not in this list. Those are not Lowerbeam reaching out.
 */

export const NET_REASONS = {
  update: 'Checking for a new version',
  llama: 'Official llama.cpp build',
  models: 'Hugging Face',
  search: 'Web search',
  page: 'Fetching a page'
} as const

export type NetReason = keyof typeof NET_REASONS

export interface NetworkView {
  /** True when the switch is off: none of the requests above are sent. */
  offline: boolean
  /** Distinct reasons in flight, in the order the first of each started. */
  active: string[]
}

/** Shown when a click asks for something the switch is refusing. */
export const OFFLINE_MESSAGE =
  'Offline. Turn the network back on from the badge in the window.'
