import assert from 'node:assert/strict'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { probeAll } from '../../src/main/probe.js'
import { BenchRunner, buildBenchArgs, parseBenchJson, planBatches } from '../../src/main/bench.js'
import type { BenchProgress, BenchRequest, BenchResult } from '@shared/types.js'

let n=0; const ok=(m:string)=>{n++;console.log('  ok',m)}
const bin=(await probeAll())[0]!

console.log('argv construction')
const req: BenchRequest = { modelPath: '/models/fixture.gguf', nPrompt: 32, nGen: 16, repetitions: 1,
  gpuLayers: [], threads: [], cacheTypes: ['f16','q8_0'], flashAttn: ['on','off'], ubatch: [] }
const args = buildBenchArgs(bin, req)
assert.equal(args[0], 'bench'); ok('unified CLI gets the bench subcommand')
assert.ok(args.includes('-o') && args[args.indexOf('-o')+1]==='json'); ok('asks for JSON, not markdown')
assert.ok(args.includes('--progress')); ok('asks for progress so a long run is not a black box')
assert.equal(args[args.indexOf('-ctk')+1], 'f16,q8_0'); ok('sweeps are comma-joined for llama-bench to expand')
assert.equal(args[args.indexOf('-fa')+1], 'on,off'); ok('flash-attn sweep passed through')
assert.ok(!args.includes('-ngl')); ok("empty sweeps are omitted, leaving llama.cpp's default alone")
const classic = buildBenchArgs({...bin, kind:'llama-server', argvPrefix:[]}, req)
assert.notEqual(classic[0], 'bench'); ok('standalone llama-bench gets no subcommand')

console.log('output parsing')
const parsed = parseBenchJson('ggml_vulkan: noise\n[{"n_prompt":512,"n_gen":0,"avg_ts":1000,"stddev_ts":5,"n_gpu_layers":-1,"type_k":"f16","type_v":"f16","flash_attn":1,"n_threads":8,"n_ubatch":512,"backends":"Vulkan","model_type":"x","build_commit":"abc"},{"n_prompt":0,"n_gen":128,"avg_ts":300,"stddev_ts":1,"flash_attn":0}]')
assert.equal(parsed.length,2); ok('parses the JSON array past backend banners')
assert.equal(parsed[0]!.kind,'prompt'); assert.equal(parsed[1]!.kind,'generation')
ok('separates prompt processing from generation')
assert.equal(parsed[0]!.flashAttn,'on'); assert.equal(parsed[1]!.flashAttn,'off')
ok('maps flash_attn 1/0 to on/off')
assert.equal(parseBenchJson('[{"avg_ts":5,"flash_attn":-1}]')[0]!.flashAttn,'auto')
ok('reports -1 as auto rather than inventing a value')
assert.throws(()=>parseBenchJson('no json here')); ok('rejects unparseable output')

console.log('batching around llama.cpp constraints')
// A quantised KV cache cannot create a context with flash attention off, and
// llama-bench expands its own cross product, so one bad pairing kills the sweep.
const split = planBatches({ ...req, cacheTypes: ['f16','q8_0','q4_0'], flashAttn: ['on','off'] })
assert.equal(split.length, 3); ok('one run per KV type, so K and V always match')
assert.deepEqual(split.map(b=>b.cacheTypes), [['f16'],['q8_0'],['q4_0']])
ok('each run pins a single cache type — no mismatched K/V cross product')
assert.deepEqual(split[0]!.flashAttn, ['on','off']); ok('f16 keeps both flash-attention settings')
assert.deepEqual(split[1]!.flashAttn, ['on']); assert.deepEqual(split[2]!.flashAttn, ['on'])
ok('quantised KV is forced to flash attention on, which llama.cpp requires')
assert.equal(planBatches({ ...req, cacheTypes: ['f16'], flashAttn: ['on','off'] }).length, 1)
ok('a single-type sweep stays a single run')
assert.equal(planBatches({ ...req, cacheTypes: [] }).length, 1); ok('no KV sweep means no split')

/** A tiny model makes the live sweep fast. Missing it skips that sweep; the checks above do not need a file. */
async function localSmol(): Promise<string | null> {
  const root = join(homedir(), '.cache/huggingface/hub/models--unsloth--SmolLM2-135M-Instruct-GGUF/snapshots')
  try {
    for (const rev of await readdir(root)) {
      const path = join(root, rev, 'SmolLM2-135M-Instruct-Q2_K.gguf')
      try {
        await stat(path)
        return path
      } catch {
        // This snapshot does not have the file.
      }
    }
  } catch {
    // The repo is not in the cache.
  }
  return null
}

const MODEL = await localSmol()
if (!MODEL) {
  console.log('\nSmolLM2-135M is not in the cache, so the live llama-bench run was skipped.')
  console.log(`\n${n} assertions passed`)
  process.exit(0)
}

console.log('a real sweep: flash attention on vs off')
const runner = new BenchRunner()
const progress: BenchProgress[] = []
runner.on('progress', p=>progress.push(p))
const results = await new Promise<BenchResult[]>((res, rej)=>{
  runner.on('done', res); runner.on('failed', e=>rej(new Error(e)))
  runner.start(bin, { modelPath: MODEL, nPrompt: 64, nGen: 32, repetitions: 1,
    gpuLayers: [], threads: [], cacheTypes: [], flashAttn: ['on','off'], ubatch: [] })
})
console.log(`   progress events: ${progress.length}, last ${progress.at(-1)?.current}/${progress.at(-1)?.total}`)
for (const r of results) console.log(`   ${r.kind.padEnd(10)} fa=${r.flashAttn.padEnd(4)} ${r.tokensPerSecond.toFixed(1).padStart(9)} tok/s ±${r.stddev.toFixed(1)}  [${r.backend}]`)
assert.equal(results.length, 4); ok('4 rows: prompt+generation for each of fa on/off')
assert.ok(progress.length>0 && progress.at(-1)!.total===4); ok(`progress reported ${progress.length} times, total 4`)
assert.ok(results.every(r=>r.tokensPerSecond>0)); ok('every row has a real throughput')
assert.ok(results.some(r=>r.kind==='prompt') && results.some(r=>r.kind==='generation'))
ok('both workloads measured')
assert.ok(results.every(r=>r.backend==='Vulkan')); ok(`backend recorded (${results[0]!.backend})`)
const pp=results.filter(r=>r.kind==='prompt'), tg=results.filter(r=>r.kind==='generation')
assert.ok(pp[0]!.tokensPerSecond > tg[0]!.tokensPerSecond)
ok('prompt processing is faster than generation, as expected')

console.log('a real mixed sweep that would previously abort entirely')
const mixed = await new Promise<BenchResult[]>((res, rej)=>{
  const r2 = new BenchRunner()
  r2.on('done', res); r2.on('failed', e=>rej(new Error(e)))
  r2.start(bin, { modelPath: MODEL, nPrompt: 32, nGen: 16, repetitions: 1,
    gpuLayers: [], threads: [], cacheTypes: ['f16','q8_0'], flashAttn: ['on','off'], ubatch: [] })
})
for (const r of mixed.filter(x=>x.kind==='generation'))
  console.log(`   generation kv=${r.cacheTypeK.padEnd(5)} fa=${r.flashAttn.padEnd(4)} ${r.tokensPerSecond.toFixed(1)} tok/s`)
assert.ok(mixed.length >= 6, `expected both batches, got ${mixed.length} rows`)
ok(`both batches ran and merged (${mixed.length} rows)`)
assert.ok(mixed.every(r=>r.cacheTypeK===r.cacheTypeV), 'K and V should always match')
ok('every row has matching K and V cache types')
const genKeys = mixed.filter(r=>r.kind==='generation').map(r=>`${r.cacheTypeK}/${r.flashAttn}`)
assert.equal(new Set(genKeys).size, genKeys.length, `duplicate configs: ${genKeys}`)
ok('no duplicate configurations in the results')
assert.ok(mixed.some(r=>r.cacheTypeK==='f16' && r.flashAttn==='off')); ok('f16 with flash attention off was measured')
assert.ok(mixed.some(r=>r.cacheTypeK==='q8_0')); ok('quantised KV was measured too')
assert.ok(!mixed.some(r=>r.cacheTypeK==='q8_0' && r.flashAttn==='off')); ok('no invalid quantised+fa-off combination attempted')

console.log('guard rails')
const busy = new BenchRunner()
busy.start(bin, { modelPath: MODEL, nPrompt:16, nGen:8, repetitions:1, gpuLayers:[], threads:[], cacheTypes:[], flashAttn:[], ubatch:[] })
assert.throws(()=>busy.start(bin, req), /already running/); ok('refuses a second concurrent benchmark')
const cancelled = await new Promise<string>((res)=>{ busy.on('failed', res); busy.cancel() })
assert.match(cancelled, /cancelled/i); ok('cancel stops the run and says so')

console.log(`\n${n} assertions passed`)
process.exit(0)
