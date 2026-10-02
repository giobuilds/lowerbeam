import type { ConversationView } from './types.js'

/**
 * A conversation as Markdown: what was said, by whom, and with which model,
 * readable anywhere. Reasoning goes in a collapsed block, tool calls as one
 * line each, and images as a note — they are data URLs, which belong in the
 * JSON export, not in a document meant to be read.
 */
export function conversationMarkdown(c: ConversationView): string {
  const lines: string[] = [`# ${c.title}`, '', `*${new Date(c.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC, exported from Lowerbeam*`, '']
  if (c.systemPrompt.trim()) lines.push('**System prompt**', '', quote(c.systemPrompt), '')
  for (const m of c.messages) {
    if (m.role === 'system') continue
    const who = m.role === 'user' ? 'You' : `Model${m.model ? ` (${m.model})` : ''}`
    lines.push(`## ${who}`, '')
    if (m.images?.length) lines.push(`*[${m.images.length} image${m.images.length === 1 ? '' : 's'} attached]*`, '')
    if (m.reasoning?.trim()) lines.push('<details><summary>Reasoning</summary>', '', m.reasoning.trim(), '', '</details>', '')
    for (const t of m.toolCalls ?? []) lines.push(`- \`${t.name}\`${t.summary ? `: ${t.summary}` : ''}`)
    if (m.toolCalls?.length) lines.push('')
    if (m.content.trim()) lines.push(m.content.trim(), '')
    if (m.stopped) lines.push('*[stopped before the end]*', '')
    if (m.error) lines.push(`*[error: ${m.error}]*`, '')
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function quote(text: string): string {
  return text.trim().split('\n').map((l) => `> ${l}`).join('\n')
}

/** A file name from a title: what a person would type, safe on any filesystem. */
export function exportFileName(title: string, ext: 'md' | 'json'): string {
  const base = title.replace(/[/\\?%*:|"<>\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'conversation'
  return `${base}.${ext}`
}

/**
 * Where a conversation matches a search, as a line to show, or null. Every
 * word of the query has to appear, in any order and either case; the title is
 * checked first, then the messages, and the snippet is the stretch around the
 * first word found.
 */
export function matchConversation(c: Pick<ConversationView, 'title' | 'messages'>, query: string): { where: 'title' | 'message'; snippet: string } | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  const texts = [c.title, ...c.messages.filter((m) => m.role !== 'system').map((m) => m.content)]
  const all = texts.join('\n').toLowerCase()
  if (!words.every((w) => all.includes(w))) return null
  if (words.every((w) => c.title.toLowerCase().includes(w))) return { where: 'title', snippet: c.title }
  for (const m of c.messages) {
    if (m.role === 'system') continue
    const at = m.content.toLowerCase().indexOf(words[0]!)
    if (at < 0) continue
    const start = Math.max(0, at - 40)
    const end = Math.min(m.content.length, at + words[0]!.length + 80)
    const snippet = `${start > 0 ? '…' : ''}${m.content.slice(start, end).replace(/\s+/g, ' ').trim()}${end < m.content.length ? '…' : ''}`
    return { where: 'message', snippet }
  }
  return { where: 'message', snippet: c.title }
}
