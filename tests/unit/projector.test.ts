import assert from 'node:assert/strict'
import { planVram, PROJECTOR_FACTOR } from '../../src/main/planner.js'
import { buildArgs } from '../../src/main/supervisor.js'
import { launchConfigSchema, planRequestSchema } from '@shared/schema.js'
import type { GgufMetadata } from '../../src/main/gguf.js'
import { DEFAULT_LAUNCH_CONFIG } from '@shared/types.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }
const MiB = 1024 * 1024

// #147: the vision projector counted in the plan, and placed where it costs least.
console.log('the launch')
{
  const bin = { path: '/x', kind: 'unified' as const, argvPrefix: ['serve'], version: 't', flags: ['--no-mmproj-offload'], flashAttnStyle: 'value' as const, devices: [], label: 't', flagDocs: [] }
  const cfg = { ...DEFAULT_LAUNCH_CONFIG, modelPath: '/m/9b.gguf', mmprojPath: '/m/mmproj.gguf' }
  const gpu = buildArgs(cfg, 1, bin)
  assert.equal(gpu[gpu.indexOf('--mmproj') + 1], '/m/mmproj.gguf'); assert.ok(!gpu.includes('--no-mmproj-offload')); ok('by default the projector goes on the GPU, as llama.cpp does')
  assert.ok(buildArgs({ ...cfg, mmprojOffload: false }, 1, bin).includes('--no-mmproj-offload')); ok('kept on the CPU when asked')
  assert.ok(!buildArgs({ ...cfg, mmprojOffload: false }, 1, { ...bin, flags: [] }).includes('--no-mmproj-offload')); ok('not offered to a binary without the flag')
  assert.ok(!buildArgs({ ...cfg, mmprojPath: null, mmprojOffload: false }, 1, bin).includes('--no-mmproj-offload')); ok('nothing about a projector when there is none')
  assert.equal(launchConfigSchema.parse({ ...cfg, mmprojOffload: false }).mmprojOffload, false); assert.equal(planRequestSchema.parse({ modelPath: '/m', gpuLayers: 1, contextSize: 1, cacheTypeK: 'f16', cacheTypeV: 'f16', parallel: 1, mmprojPath: '/p', mmprojOffload: true }).mmprojPath, '/p'); ok('the choice is carried by launches, profiles and plans')
}

console.log('\nthe plan')
{
  const meta = { path: '/m/9b.gguf', fileName: '9b.gguf', fileSize: 5780090816, architecture: 'qwen35', name: '', blockCount: 33, contextLength: 262144, embeddingLength: 4096, headCount: 16, headCountKv: 4, keyLength: 256, valueLength: 256, quant: null, parameterCount: null, hasChatTemplate: true, vocabSize: 248320, isProjector: false, feedForwardLength: 12288, expertCount: null, expertUsedCount: null, expertFeedForwardLength: null, fullAttentionInterval: 4, nextnLayers: 1, unusedBytes: 144 * MiB, embeddingBytes: 545 * MiB } as GgufMetadata
  const input = { meta, gpuLayers: 999, contextSize: 16384, cacheTypeK: 'f16' as const, cacheTypeV: 'f16' as const, parallel: 1 }
  const without = planVram(input, 7000)
  const withIt = planVram({ ...input, projectorBytes: 921704672 }, 7000)
  assert.equal(without.projectorMiB, 0)
  assert.equal(Math.round(withIt.projectorMiB), 1152); assert.equal(Math.round(withIt.totalMiB - without.totalMiB), 1152); ok('the 9B’s BF16 projector on the GPU: 1,152 MiB, what llama.cpp reserved for it')
  assert.ok(withIt.notes.some((x) => x.startsWith('vision projector on the GPU'))); ok('and the plan says so')
  assert.ok(withIt.maxGpuLayers! < without.maxGpuLayers! || withIt.totalMiB > 7000 - 1024); ok('with it, the 9B and a coding context no longer fit with --fit’s margin on 7 GB free')
  assert.equal(planVram({ ...input, gpuLayers: 0, projectorBytes: 921704672 }, null).projectorMiB, 0); ok('nothing on the GPU when nothing is offloaded')
  assert.ok(PROJECTOR_FACTOR > 1.3 && PROJECTOR_FACTOR < 1.32); ok('weights plus the worst-case image, as measured')
}

console.log(`\n${n} assertions passed`)
