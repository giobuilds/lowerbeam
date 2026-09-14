#!/usr/bin/env node
/**
 * The supply side of memory: what a launch of this model at each context
 * size actually takes on this card, and what it runs at.
 *
 * The planner's estimate is arithmetic from the file; this is the
 * measurement it is checked against. For each context size the model is
 * launched with the harness's own arguments, VRAM in use is read from the
 * kernel before and after the server is ready, one fixed request is made —
 * a prompt of about 3,000 tokens of the repository's own code, 128 tokens
 * generated — and the server's own timings are recorded. The result is a
 * table in tests/harness/results/memory-<stamp>.md.
 *
 *   node tests/harness/memory.mjs                       # the 9B at 4k … 64k
 *   node tests/harness/memory.mjs --ctx 4096,16384      # chosen sizes
 *   node tests/harness/memory.mjs --model <path.gguf>
 */
import { spawn, execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const repo = process.cwd()
const LLAMA = join(homedir(), '.local/bin/llama')
const PORT = 8992
const DEFAULT_MODEL = join(
  homedir(),
  '.cache/huggingface/hub/models--ornith-ai--Ornith-1.5-9B-GGUF/snapshots/abdd624b12ebf020b767fff532ff44fe552b28c3/Ornith-1.5-9B-Q4_K_M.gguf'
)
const args = process.argv.slice(2)
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : DEFAULT_MODEL
const sizes = args.includes('--ctx') ? args[args.indexOf('--ctx') + 1].split(',').map(Number) : [4096, 8192, 16384, 32768, 65536]

async function vramUsed() {
  const cards = (await readdir('/sys/class/drm')).filter((c) => /^card\d+$/.test(c))
  let used = 0
  let total = 0
  for (const c of cards) {
    try {
      used += Number(await readFile(`/sys/class/drm/${c}/device/mem_info_vram_used`, 'utf8'))
      total += Number(await readFile(`/sys/class/drm/${c}/device/mem_info_vram_total`, 'utf8'))
    } catch {
      /* not an amdgpu card */
    }
  }
  return { used, total }
}

const MiB = (b) => Math.round(b / 1048576)

async function prompt() {
  // The repository's own code, a fixed slice, so every launch sees the same tokens.
  const files = ['src/agent/loop.ts', 'src/agent/tools.ts', 'src/context/checkpoint.ts']
  let text = ''
  for (const f of files) text += `\n// ${f}\n` + (await readFile(join(repo, f), 'utf8'))
  return 'Read the following code and name the exported functions, one per line.\n' + text.slice(0, 11000)
}

async function launch(ctx) {
  const child = spawn(
    LLAMA,
    ['serve', '-m', model, '--host', '127.0.0.1', '--port', String(PORT), '--parallel', '1', '--flash-attn', 'on', '--jinja', '--slots', '--props', '--gpu-layers', '999', '--ctx-size', String(ctx), '--reasoning-budget', '0'],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true }
  )
  let stderr = ''
  child.stderr.on('data', (c) => (stderr = (stderr + c).slice(-8000)))
  const started = Date.now()
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (child.exitCode !== null) return { child: null, stderr, ms: Date.now() - started }
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return { child, stderr, ms: Date.now() - started }
    } catch {
      /* not up yet */
    }
  }
  kill(child)
  return { child: null, stderr, ms: Date.now() - started }
}

function kill(child) {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

async function main() {
  const text = await prompt()
  const idle = await vramUsed()
  const rows = []
  console.log(`model ${model.split('/').pop()}; VRAM idle ${MiB(idle.used)} MiB of ${MiB(idle.total)} MiB`)
  for (const ctx of sizes) {
    const before = await vramUsed()
    const { child, stderr, ms } = await launch(ctx)
    if (!child) {
      rows.push({ ctx, ok: false, note: `did not start in ${Math.round(ms / 1000)}s: ${stderr.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 160)}` })
      console.log(`  ${ctx}: did not start`)
      continue
    }
    const loaded = await vramUsed()
    let timings = null
    let error = null
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: text }], max_tokens: 128, temperature: 0, stream: false }),
        signal: AbortSignal.timeout(300_000)
      })
      const body = await res.json()
      timings = body.timings ?? null
      if (!res.ok) error = JSON.stringify(body).slice(0, 160)
    } catch (err) {
      error = String(err.message).slice(0, 160)
    }
    const peak = await vramUsed()
    kill(child)
    for (let i = 0; i < 30 && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 500))
    const row = {
      ctx,
      ok: !error,
      loadMs: ms,
      loadedMiB: MiB(loaded.used - before.used),
      peakMiB: MiB(peak.used - before.used),
      promptTokens: timings?.prompt_n ?? null,
      promptTps: timings?.prompt_per_second ?? null,
      genTps: timings?.predicted_per_second ?? null,
      note: error ?? ''
    }
    rows.push(row)
    console.log(`  ${ctx}: loaded ${row.loadedMiB} MiB, peak ${row.peakMiB} MiB, prompt ${row.promptTokens} tok at ${row.promptTps?.toFixed(0)} t/s, generation ${row.genTps?.toFixed(1)} t/s${error ? ' — ' + error : ''}`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const lines = [
    `# Memory at each context size`,
    '',
    `Model ${model.split('/').pop()}, ${execFileSync(LLAMA, ['--version']).toString().split('\n')[0]?.trim()}, one slot, flash attention on, every layer on the GPU. VRAM in use read from the kernel; "loaded" is the rise once the server is ready, "peak" the rise after one request of about ${rows.find((r) => r.promptTokens)?.promptTokens ?? '?'} prompt tokens and 128 generated. Idle VRAM ${MiB(idle.used)} MiB of ${MiB(idle.total)} MiB.`,
    '',
    '| context | loaded MiB | peak MiB | load s | prompt t/s | generation t/s | note |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.ctx.toLocaleString()} | ${r.loadedMiB ?? '—'} | ${r.peakMiB ?? '—'} | ${r.loadMs ? (r.loadMs / 1000).toFixed(1) : '—'} | ${r.promptTps?.toFixed(0) ?? '—'} | ${r.genTps?.toFixed(1) ?? '—'} | ${r.note} |`)
  ]
  await mkdir(join(repo, 'tests/harness/results'), { recursive: true })
  const out = join(repo, 'tests/harness/results', `memory-${stamp}.md`)
  await writeFile(out, lines.join('\n') + '\n')
  console.log(`\n${lines.join('\n')}\nwritten to ${out}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
