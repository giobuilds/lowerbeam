import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { authHeaders } from '@shared/chatClient.js'
import type { ServerStatus } from '@shared/types.js'
import { writeFileAtomic } from './atomicWrite.js'
import { readFile } from 'node:fs/promises'

/**
 * A long chat's place in the server, kept when you leave it and put back
 * when you return.
 *
 * Re-reading a long conversation is the slow part on a small GPU: 8,000
 * tokens of prompt take the 9B seventeen seconds on an RX 6600, and a
 * conversation loses its place as soon as another one uses its slot. So
 * each chat goes back to the slot it last used, and when you leave a long
 * one its slot is saved to disk with llama-server's own slot save; when you
 * come back and its slot has gone to another chat, it is restored into a
 * free one first. Restoring 325 MB takes about 150 ms.
 *
 * Whether a restore actually helps depends on the model and the llama.cpp
 * build: a hybrid model (recurrent layers beside attention) can only reuse a
 * cache by rolling back to checkpoints kept in memory, which a saved file
 * does not carry, so on build 10826 a restored Qwen3.5-family slot is read
 * again from the start anyway. Rather than guess, the first reply after a
 * restore says how much it reused; if it reused little, saving stops for
 * that model under that build and its files are deleted.
 *
 * Files are named by conversation, bounded in total size (oldest dropped
 * first), removed with their conversation, and swept on start.
 */

/** A conversation is saved when leaving it only past this many tokens: below it, re-reading is quick. */
export const SAVE_FROM_TOKENS = 2048
/** All saved slots together; the least recently used go first. */
export const SLOT_BUDGET_BYTES = 4 * 1024 ** 3

interface Entry {
  conversationId: string
  /** Which model, under which build, at what window: a saved slot is only valid for exactly these. */
  model: string
  build: string
  contextPerSlot: number
  tokens: number
  bytes: number
  savedAt: number
  usedAt: number
}

interface Index {
  entries: Record<string, Entry>
  /** Model and build pairs where a restore was measured not to help. */
  ineffective: string[]
}

export interface SlotServer {
  status: ServerStatus
  build: string
}

export class SlotCache {
  private index: Index | null = null
  /** Which conversation each slot of the running server last served, and the reverse. */
  private holder = new Map<number, string>()
  private slotOf = new Map<string, number>()
  /** Conversations restored since their last reply, with how many tokens came back. */
  private pending = new Map<string, number>()
  private serverKey = ''

  constructor(
    readonly dir: string,
    private readonly server: () => SlotServer | null,
    private readonly budget = SLOT_BUDGET_BYTES
  ) {}

  /**
   * The slot a conversation's next request should use, restoring its saved
   * state into it first when that is what it needs. Null when there is no
   * one-model server, or every slot is busy: the server then picks.
   */
  async prepare(conversationId: string): Promise<{ slot: number; restored: number | null } | null> {
    const ctx = this.context()
    if (!ctx) return null
    const slots = await this.slots(ctx)
    if (!slots) return null
    const idle = (id: number): boolean => slots.some((s) => s.id === id && !s.is_processing)
    const own = this.slotOf.get(conversationId)
    // Its slot still holds it: nothing to do but go back there.
    if (own !== undefined && this.holder.get(own) === conversationId && idle(own)) return { slot: own, restored: null }

    const free = slots.filter((s) => !s.is_processing).map((s) => s.id)
    if (free.length === 0) return null
    // A slot nobody has used yet, else any idle one.
    const slot = free.find((id) => !this.holder.has(id)) ?? free[0]!
    this.claim(slot, conversationId)

    const index = await this.load()
    const entry = index.entries[conversationId]
    if (!entry) return { slot, restored: null }
    // An edited conversation is restored all the same: the server compares
    // tokens and reuses only what still matches, which is the part before
    // the edit. Another model, build or window is a different cache.
    if (!this.matches(entry, ctx)) {
      await this.drop(conversationId)
      return { slot, restored: null }
    }
    try {
      const res = await this.post(ctx, `/slots/${slot}?action=restore`, { filename: fileName(conversationId) })
      const restored = Number((res as { n_restored?: number }).n_restored ?? 0)
      entry.usedAt = Date.now()
      await this.save()
      if (restored > 0) this.pending.set(conversationId, restored)
      return { slot, restored }
    } catch {
      await this.drop(conversationId)
      return { slot, restored: null }
    }
  }

  /**
   * The reply after a restore, as the server counted it. A restore that
   * reused under half of what it put back did not help this model under
   * this build: saving stops for them, and their files go.
   */
  async report(conversationId: string, cacheTokens: number): Promise<void> {
    const restored = this.pending.get(conversationId)
    if (restored === undefined) return
    this.pending.delete(conversationId)
    const ctx = this.context()
    if (!ctx || cacheTokens >= restored / 2) return
    const index = await this.load()
    const key = modelKey(ctx.model, ctx.build)
    if (!index.ineffective.includes(key)) index.ineffective.push(key)
    for (const [id, e] of Object.entries(index.entries)) {
      if (modelKey(e.model, e.build) === key) {
        await rm(join(this.dir, fileName(id)), { force: true })
        delete index.entries[id]
      }
    }
    await this.save()
  }

  /** Leaving a conversation: save its slot, if it is long enough and its slot still holds it. */
  async leave(conversationId: string, tokens: number): Promise<boolean> {
    const ctx = this.context()
    if (!ctx || tokens < SAVE_FROM_TOKENS) return false
    const slot = this.slotOf.get(conversationId)
    if (slot === undefined || this.holder.get(slot) !== conversationId) return false
    const index = await this.load()
    if (index.ineffective.includes(modelKey(ctx.model, ctx.build))) return false
    const slots = await this.slots(ctx)
    if (!slots?.some((s) => s.id === slot && !s.is_processing)) return false
    try {
      await this.post(ctx, `/slots/${slot}?action=save`, { filename: fileName(conversationId) })
      const bytes = (await stat(join(this.dir, fileName(conversationId)))).size
      const now = Date.now()
      index.entries[conversationId] = {
        conversationId,
        model: ctx.model,
        build: ctx.build,
        contextPerSlot: ctx.contextPerSlot,
        tokens,
        bytes,
        savedAt: now,
        usedAt: now
      }
      await this.trim()
      await this.save()
      return true
    } catch {
      return false
    }
  }

  /** A deleted conversation's saved slot goes with it. */
  async drop(conversationId: string): Promise<void> {
    const index = await this.load()
    await rm(join(this.dir, fileName(conversationId)), { force: true })
    if (index.entries[conversationId]) {
      delete index.entries[conversationId]
      await this.save()
    }
  }

  /**
   * On start: files no entry names, and entries for conversations that no
   * longer exist or whose file is gone, removed.
   */
  async sweep(conversationExists: (id: string) => Promise<boolean>): Promise<void> {
    const index = await this.load()
    for (const [id, e] of Object.entries(index.entries)) {
      const file = await stat(join(this.dir, fileName(id))).catch(() => null)
      if (!file || !(await conversationExists(id))) {
        await rm(join(this.dir, fileName(id)), { force: true })
        delete index.entries[id]
      } else e.bytes = file.size
    }
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const id = name.replace(/\.bin$/, '')
      if (name !== 'index.json' && !index.entries[id]) await rm(join(this.dir, name), { force: true })
    }
    await this.trim()
    await this.save()
  }

  /** Bytes of saved slots, for the Data row. */
  async usage(): Promise<{ count: number; bytes: number }> {
    const entries = Object.values((await this.load()).entries)
    return { count: entries.length, bytes: entries.reduce((n, e) => n + e.bytes, 0) }
  }

  /** Every saved slot gone, and what restores were measured to do kept. */
  async clear(): Promise<void> {
    const index = await this.load()
    for (const id of Object.keys(index.entries)) await rm(join(this.dir, fileName(id)), { force: true })
    index.entries = {}
    await this.save()
  }

  private claim(slot: number, conversationId: string): void {
    const previous = this.slotOf.get(conversationId)
    if (previous !== undefined && this.holder.get(previous) === conversationId) this.holder.delete(previous)
    this.holder.set(slot, conversationId)
    this.slotOf.set(conversationId, slot)
  }

  private async trim(): Promise<void> {
    const index = await this.load()
    const entries = Object.values(index.entries).sort((a, b) => b.usedAt - a.usedAt)
    let total = 0
    for (const e of entries) {
      total += e.bytes
      if (total > this.budget) {
        await rm(join(this.dir, fileName(e.conversationId)), { force: true })
        delete index.entries[e.conversationId]
      }
    }
  }

  private matches(e: Entry, ctx: Context): boolean {
    return e.model === ctx.model && e.build === ctx.build && e.contextPerSlot === ctx.contextPerSlot
  }

  /** The running one-model server, or null. A new launch forgets which chat held which slot. */
  private context(): Context | null {
    const s = this.server()
    const st = s?.status
    if (!s || !st || st.phase !== 'ready' || !st.port || !st.config || st.router || !st.contextPerSlot) return null
    const ctx = { url: `http://127.0.0.1:${st.port}`, apiKey: st.apiKey, model: st.config.modelPath, build: s.build, contextPerSlot: st.contextPerSlot }
    const key = `${st.pid}:${st.port}`
    if (key !== this.serverKey) {
      this.serverKey = key
      this.holder.clear()
      this.slotOf.clear()
      this.pending.clear()
    }
    return ctx
  }

  private async slots(ctx: Context): Promise<Array<{ id: number; is_processing: boolean }> | null> {
    try {
      const res = await fetch(`${ctx.url}/slots`, { headers: authHeaders(ctx.apiKey), signal: AbortSignal.timeout(3000) })
      return res.ok ? ((await res.json()) as Array<{ id: number; is_processing: boolean }>) : null
    } catch {
      return null
    }
  }

  private async post(ctx: Context, path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${ctx.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(ctx.apiKey) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  private async load(): Promise<Index> {
    if (this.index) return this.index
    try {
      const raw = JSON.parse(await readFile(join(this.dir, 'index.json'), 'utf8')) as Partial<Index>
      this.index = { entries: raw.entries ?? {}, ineffective: raw.ineffective ?? [] }
    } catch {
      this.index = { entries: {}, ineffective: [] }
    }
    return this.index
  }

  private async save(): Promise<void> {
    await writeFileAtomic(join(this.dir, 'index.json'), JSON.stringify(await this.load(), null, 2))
  }
}

interface Context {
  url: string
  apiKey: string | null
  model: string
  build: string
  contextPerSlot: number
}

function fileName(conversationId: string): string {
  // Conversation ids are our own UUIDs, but they cross IPC; the server
  // refuses anything with a path in it, and so does this.
  if (!/^[a-f0-9-]{36}$/i.test(conversationId)) throw new Error('invalid conversation id')
  return `${conversationId}.bin`
}

function modelKey(model: string, build: string): string {
  return `${model}\u0000${build}`
}
