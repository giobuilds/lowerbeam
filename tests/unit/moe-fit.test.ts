import assert from 'node:assert/strict'
import type { GgufMetadata } from '../../src/main/gguf.js'
import { hybridKvNote, verdictFor } from '../../src/main/remoteFit.js'
import { withHybridExperts } from '../../src/main/hybridLaunch.js'
import { recommendedQuant } from '../../src/shared/moeFit.js'
import { DEFAULT_LAUNCH_CONFIG, type LaunchConfig } from '../../src/shared/types.js'

let n = 0
const ok = (m: string) => {
  n++
  console.log('  ok', m)
}

const meta: GgufMetadata = {
  path: '/fixture/moe.gguf',
  fileName: 'moe.gguf',
  fileSize: 12 * 1024 * 1024 * 1024,
  architecture: 'qwen3moe',
  name: 'Qwen3.8-35B-A3B',
  fullAttentionInterval: 4,
  nextnLayers: null,
  blockCount: 40,
  contextLength: 262144,
  embeddingLength: 2048,
  headCount: 16,
  headCountKv: 2,
  quant: 'Q4_K_M',
  parameterCount: null,
  hasChatTemplate: true,
  vocabSize: 151936,
  isProjector: false,
  feedForwardLength: null,
  keyLength: 128,
  valueLength: 128,
  expertCount: 128,
  expertUsedCount: 8,
  expertFeedForwardLength: 768
}

console.log('fit follows hybrid placement, not VRAM alone')
{
  assert.equal(verdictFor(10, 40, 'hybrid-moe'), 'hybrid')
  assert.equal(verdictFor(40, 40, ''), 'full')
  assert.equal(verdictFor(12, 40, ''), 'partial')
  assert.equal(verdictFor(0, 40, ''), 'cpu')
  assert.equal(verdictFor(40, 40, 'wont-load'), 'cpu')
  ok('a hybrid MoE is hybrid even when layers spill, and a file beyond RAM is not called a partial')
}

console.log('\nthe KV warning is about the trained context, not the 4k estimate')
{
  assert.match(hybridKvNote(meta, 7344) ?? '', /262,144/)
  assert.match(hybridKvNote(meta, 7344) ?? '', /KV cache/)
  assert.equal(hybridKvNote({ ...meta, contextLength: 8192 }, 7344), null)
  ok('a 256k context warns; a short trained context does not')
}

console.log('\nwhich quant to recommend')
{
  const file = (name: string, size: number) => ({ path: name, size, isProjector: false, isDraft: false })
  const files = [
    file('Qwen3.8-35B-A3B-IQ2_M.gguf', 12),
    file('Qwen3.8-35B-A3B-Q3_K_M.gguf', 16),
    file('Qwen3.8-35B-A3B-Q4_K_M.gguf', 20),
    file('Qwen3.8-35B-A3B-Q8_0.gguf', 40),
    file('mmproj-Qwen3.8.gguf', 1),
    file('Qwen3.8-35B-A3B-Q4_K_M-mtp.gguf', 1)
  ]
  const hybrid = Object.fromEntries(files.map((f) => [f.path, { verdict: 'hybrid' }]))
  hybrid['mmproj-Qwen3.8.gguf'] = { verdict: 'full' }
  files[4]!.isProjector = true
  files[5]!.isDraft = true

  assert.equal(recommendedQuant(files, hybrid, 8192), 'Qwen3.8-35B-A3B-IQ2_M.gguf')
  assert.equal(recommendedQuant(files, hybrid, 7344), 'Qwen3.8-35B-A3B-IQ2_M.gguf')
  assert.equal(recommendedQuant(files, hybrid, 12288), 'Qwen3.8-35B-A3B-Q4_K_M.gguf')
  assert.equal(recommendedQuant(files, hybrid, 6000), null)
  const noIq2 = files.filter((f) => !f.path.includes('IQ2'))
  assert.equal(recommendedQuant(noIq2, hybrid, 8192), 'Qwen3.8-35B-A3B-Q3_K_M.gguf')
  const onlyQ8 = { 'Qwen3.8-35B-A3B-Q8_0.gguf': { verdict: 'hybrid' } }
  assert.equal(recommendedQuant(files, onlyQ8, 12288), null)
  const withFull = { ...hybrid, 'Qwen3.8-35B-A3B-Q3_K_M.gguf': { verdict: 'full' }, 'Qwen3.8-35B-A3B-Q4_K_M.gguf': { verdict: 'full' } }
  assert.equal(recommendedQuant(files, withFull, 8192), 'Qwen3.8-35B-A3B-Q4_K_M.gguf')
  ok('8 GB prefers IQ2_M then Q3, 12 GB prefers Q4_K_M, and a full-VRAM quant still wins')
}

console.log('\nserve applies hybrid when the saved launch never did')
{
  const flags = ['--cpu-moe', '--n-cpu-moe', '--flash-attn', '--fit']
  const launch = (patch: Partial<LaunchConfig> = {}): LaunchConfig => ({
    modelPath: '/m/moe.gguf',
    ...DEFAULT_LAUNCH_CONFIG,
    ...patch
  })
  const ram = 16 * 1024 * 1024 * 1024
  const applied = withHybridExperts(launch(), meta, 7344, ram, flags)
  assert.equal(applied.config.cpuMoeLayers, -1)
  assert.equal(applied.config.cacheTypeK, 'q8_0')
  assert.equal(applied.config.cacheTypeV, 'q8_0')
  assert.equal(applied.config.flashAttn, true)
  assert.match(applied.note ?? '', /--cpu-moe/)
  ok('a 35B-class MoE that misses VRAM is served with --cpu-moe and q8_0 KV')

  const short = withHybridExperts(launch(), { ...meta, contextLength: 4096 }, 7344, ram, flags)
  assert.equal(short.config.cpuMoeLayers, -1)
  assert.equal(short.config.cacheTypeK, 'f16')
  ok('a short trained context keeps the saved f16 cache')

  const chosen = withHybridExperts(launch({ cpuMoeLayers: 8, cacheTypeK: 'q4_0', cacheTypeV: 'q4_0' }), meta, 7344, ram, flags)
  assert.equal(chosen.config.cpuMoeLayers, 8)
  assert.equal(chosen.config.cacheTypeK, 'q4_0')
  assert.equal(chosen.note, null)
  ok('a launch that already placed the experts is left alone')

  const fits = withHybridExperts(launch(), { ...meta, fileSize: 400 * 1024 * 1024 }, 7344, ram, flags)
  assert.equal(fits.config.cpuMoeLayers, 0)
  assert.equal(fits.note, null)
  ok('a model that fits on the GPU is not moved to system RAM')

  const huge = withHybridExperts(launch(), { ...meta, fileSize: 80 * 1024 * 1024 * 1024 }, 7344, ram, flags)
  assert.equal(huge.config.cpuMoeLayers, 0)
  assert.equal(huge.note, null)
  ok('a file larger than VRAM and RAM is not claimed as a hybrid')

  const dense = withHybridExperts(launch(), { ...meta, expertCount: null, fileSize: 20 * 1024 * 1024 * 1024 }, 7344, ram, flags)
  assert.equal(dense.config.cpuMoeLayers, 0)
  ok('a dense model is not given --cpu-moe')

  const old = withHybridExperts(launch(), meta, 7344, ram, ['--fit'])
  assert.equal(old.config.cpuMoeLayers, 0)
  ok('a binary without the flag is not given it')
}

console.log(`\n${n} assertions passed`)
