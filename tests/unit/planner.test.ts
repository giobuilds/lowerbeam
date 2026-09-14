import assert from 'node:assert/strict'
import type { GgufMetadata } from '../../src/main/gguf.js'
import { planVram, kvCacheBytes, computeBufferBytes, weightBytesOnGpu, attentionLayers } from '../../src/main/planner.js'

// Recorded from qwen2.5-0.5b-instruct-q4_k_m.gguf, whose allocations llama.cpp
// reported directly and which the assertions below are calibrated against. Kept
// as a fixture so the suite does not depend on that file still being on disk.
const meta: GgufMetadata = {
  path: '/fixture/qwen2.5-0.5b-instruct-q4_k_m.gguf',
  fileName: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
  fileSize: 491400032,
  architecture: 'qwen2',
  name: 'qwen2.5-0.5b-instruct',
  fullAttentionInterval: null, nextnLayers: null,
  blockCount: 24, contextLength: 32768, embeddingLength: 896,
  headCount: 14, headCountKv: 2, quant: 'Q4_K_M', parameterCount: 630000000,
  hasChatTemplate: true, vocabSize: 151936, isProjector: false,
  feedForwardLength: 4864, keyLength: null, valueLength: null,
  expertCount: null, expertUsedCount: null, expertFeedForwardLength: null
}
const MiB = 1024*1024
let n = 0; const ok=(m:string)=>{n++;console.log('  ok',m)}
const pct=(a:number,b:number)=>Math.abs(a-b)/b*100

// Ground truth, both builds, same model + GPU (RX 6600), -c 4096 -ngl 999 f16/f16:
//   weights: ROCm0 373.73 MiB (CPU_Mapped 89.26), file 462.96 MiB
//   KV:      48.00 MiB
//   compute: classic (llama-cpp b6153) 310.01 MiB | modern (llama 0.3.0-dev) 37.76 MiB
//   measured VRAM delta: classic 913 MiB | modern 647 MiB
console.log('KV cache — exact arithmetic')
assert.equal(Number((kvCacheBytes(meta,4096,'f16','f16')!/MiB).toFixed(2)), 48.00)
ok('matches llama.cpp to the byte (48.00 MiB)')
assert.equal(Math.round(kvCacheBytes(meta,32768,'f16','f16')!/MiB), 384)
ok('scales linearly with context')
assert.ok(kvCacheBytes(meta,4096,'q8_0','q8_0')! < kvCacheBytes(meta,4096,'f16','f16')!)
ok('quantised KV is smaller')

console.log('compute buffer — both build generations')
const cls = computeBufferBytes(meta,512,'classic')!/MiB
console.log(`   classic predicted ${cls.toFixed(1)} | measured 310.01 (${pct(cls,310.01).toFixed(1)}%)`)
assert.ok(pct(cls,310.01) < 6); ok('classic profile within 6%')
const mod = computeBufferBytes(meta,512,'modern')!/MiB
console.log(`   modern  predicted ${mod.toFixed(1)} | measured  37.76 (${pct(mod,37.76).toFixed(1)}%)`)
assert.ok(pct(mod,37.76) < 15); ok('modern profile within 15%')
assert.ok(cls > mod*5); ok('the two profiles differ by the ~8x that was measured')

console.log('weights on GPU')
const w = weightBytesOnGpu(meta,999)/MiB
console.log(`   predicted ${w.toFixed(1)} | measured 373.73 (${pct(w,373.73).toFixed(1)}%)`)
assert.ok(pct(w,373.73) < 12); ok('accounts for the host-resident embedding tensor')

console.log('whole-plan totals vs measured VRAM delta')
for (const [profile, measured] of [['classic',913],['modern',647]] as const) {
  const p = planVram({ meta, gpuLayers:999, contextSize:4096, cacheTypeK:'f16', cacheTypeV:'f16', computeProfile:profile }, 8142)
  console.log(`   ${profile.padEnd(8)} w${p.weightsMiB.toFixed(0)} + kv${p.kvCacheMiB.toFixed(0)} + c${p.computeMiB.toFixed(0)} + oh${p.backendOverheadMiB} = ${p.totalMiB.toFixed(0)} | measured ${measured} (${pct(p.totalMiB,measured).toFixed(1)}%)`)
  assert.ok(pct(p.totalMiB, measured) < 8, `${profile} off by ${pct(p.totalMiB,measured).toFixed(1)}%`)
  ok(`${profile} total within 8% of a real measured launch`)
}

console.log('multi-slot KV — ground truth from `-c 16384 --parallel 4`')
// llama.cpp reported: kv_cache size = 192.00 MiB (4096 cells, 24 layers, 4/4 seqs),
// n_ctx_slot = 4096. So -c is the TOTAL, divided across slots — not multiplied.
const multi = planVram({ meta, gpuLayers:999, contextSize:16384, cacheTypeK:'f16', cacheTypeV:'f16', parallel:4 }, 8142)
console.log(`   predicted KV ${multi.kvCacheMiB.toFixed(2)} MiB | llama.cpp reported 192.00 MiB`)
assert.equal(Number(multi.kvCacheMiB.toFixed(2)), 192.00)
ok('multi-slot KV matches llama.cpp exactly (192.00 MiB)')
assert.equal(multi.contextPerSlot, 4096)
ok('reports 4096 tokens per conversation, matching n_ctx_slot')
const single = planVram({ meta, gpuLayers:999, contextSize:16384, cacheTypeK:'f16', cacheTypeV:'f16', parallel:1 }, 8142)
assert.equal(single.kvCacheMiB, multi.kvCacheMiB)
ok('slot count does not change total KV, only how it is divided')
assert.equal(single.contextPerSlot, 16384)
ok('one slot gets the whole context')

console.log('refusals and suggestions')
const tight = planVram({ meta, gpuLayers:999, contextSize:32768, cacheTypeK:'f16', cacheTypeV:'f16' }, 500)
assert.equal(tight.fits,false); ok('says no when it will not fit')
assert.ok(tight.maxGpuLayers! < 25); ok(`suggests a smaller -ngl (${tight.maxGpuLayers})`)
const zero = planVram({ meta, gpuLayers:0, contextSize:4096, cacheTypeK:'f16', cacheTypeV:'f16' }, 8142)
assert.equal(zero.totalMiB,0); ok('-ngl 0 costs no VRAM, including no backend reserve')
const partial = planVram({ meta, gpuLayers:12, contextSize:4096, cacheTypeK:'f16', cacheTypeV:'f16' }, 8142)
assert.ok(partial.weightsMiB>0 && partial.weightsMiB < weightBytesOnGpu(meta,999)/MiB)
assert.ok(partial.kvCacheMiB < 48); ok('partial offload scales weights and KV together')
const noGpu = planVram({ meta, gpuLayers:999, contextSize:4096, cacheTypeK:'f16', cacheTypeV:'f16', hasGpuBackend:false }, null)
assert.equal(noGpu.backendOverheadMiB,0); ok('no backend reserve counted on a CPU-only build')

console.log('\nhybrid attention — only the blocks with a cache count')
{
  // Ornith 1.5 9B as its file states it: 33 blocks, one of them the
  // next-token head, one in four with a KV cache, 4 KV heads of 256.
  const hybrid: GgufMetadata = { ...meta, architecture: 'qwen35', blockCount: 33, nextnLayers: 1, fullAttentionInterval: 4, embeddingLength: 4096, headCount: 16, headCountKv: 4, keyLength: 256, valueLength: 256, contextLength: 262144 }
  assert.equal(attentionLayers(hybrid), 8); ok('33 blocks, one nextn, one in four cached: 8 layers hold a cache')
  assert.equal(kvCacheBytes(hybrid, 16384, 'f16', 'f16'), 8 * 2 * 16384 * 1024 * 2); ok('32 KB a token: 512 MiB at 16,384, not the 2.1 GiB that 33 layers would give')
  const trained = planVram({ meta: hybrid, gpuLayers: 999, contextSize: 0, cacheTypeK: 'f16', cacheTypeV: 'f16' }, 8142)
  assert.equal(Math.round(trained.kvCacheMiB), 8192); ok('a context of 0 is the trained length: 262,144 tokens, an 8 GiB cache')
  assert.ok(trained.notes.some((l) => l.includes('trained length'))); ok('and the notes say so')
  assert.ok(!trained.fits); ok('which does not fit an 8 GB card')
}

console.log(`\n${n} assertions passed`)
