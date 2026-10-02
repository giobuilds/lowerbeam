import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildArgs } from '../../src/main/supervisor.js'
import { embeddingBytes, expertBytesPerBlock, parseGgufHeader, readGgufMetadata, unusedBlockBytes, type GgufMetadata } from '../../src/main/gguf.js'
import { expertPlacement, planVram } from '../../src/main/planner.js'
import { DEFAULT_LAUNCH_CONFIG } from '@shared/types.js'
import { launchConfigSchema } from '@shared/schema.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }
const MiB = 1024 * 1024

console.log('expert offload becomes a launch flag')
{
  const bin = { path: '/x/llama', kind: 'unified' as const, argvPrefix: ['serve'], version: 'b1', flags: [], flashAttnStyle: 'value' as const, devices: [], label: 'llama serve' }
  const args = (cpuMoeLayers: number) => buildArgs({ modelPath: '/m.gguf', ...DEFAULT_LAUNCH_CONFIG, cpuMoeLayers }, 1, bin)
  assert.ok(!args(0).some((a) => a.includes('cpu-moe'))); ok('off: no flag')
  assert.ok(args(-1).includes('--cpu-moe')); ok('every layer: --cpu-moe')
  const some = args(24)
  assert.equal(some[some.indexOf('--n-cpu-moe') + 1], '24'); ok('the first N layers: --n-cpu-moe N')
  assert.ok(buildArgs({ modelPath: '/m.gguf', ...DEFAULT_LAUNCH_CONFIG, autoFit: true, cpuMoeLayers: -1 }, 1, { ...bin, flags: ['--fit'] }).includes('--cpu-moe')); ok('and under auto-fit too')
  const { cpuMoeLayers: _drop, ...old } = { modelPath: '/m.gguf', ...DEFAULT_LAUNCH_CONFIG }
  assert.equal(launchConfigSchema.parse(old).cpuMoeLayers, 0); ok('a saved launch from before has it off')
}

// A GGUF v3 header with a tensor table, built byte by byte.
function gguf(kv: Array<[string, 'u32' | 'str', number | string]>, tensors: Array<[string, number]>): { buf: Buffer; dataStart: number; fileSize: number } {
  const parts: Buffer[] = []
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(b) }
  const u64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); parts.push(b) }
  const str = (s: string) => { u64(Buffer.byteLength(s)); parts.push(Buffer.from(s)) }
  u32(0x46554747); u32(3); u64(tensors.length); u64(kv.length)
  for (const [k, type, v] of kv) { str(k); if (type === 'u32') { u32(4); u32(v as number) } else { u32(8); str(v as string) } }
  let offset = 0
  for (const [name, size] of tensors) { str(name); u32(1); u64(size); u32(0); u64(offset); offset += size }
  const header = Buffer.concat(parts)
  const dataStart = Math.ceil(header.length / 32) * 32
  return { buf: header, dataStart, fileSize: dataStart + offset }
}

console.log('\nthe tensor table gives exact sizes')
{
  const kv: Array<[string, 'u32' | 'str', number | string]> = [['general.architecture', 'str', 'x'], ['x.block_count', 'u32', 3], ['x.nextn_predict_layers', 'u32', 1]]
  const tensors: Array<[string, number]> = [
    ['token_embd.weight', 100], ['blk.0.attn_q.weight', 10], ['blk.0.ffn_up_exps.weight', 40], ['blk.0.ffn_down_exps.weight', 40],
    ['blk.0.ffn_up_shexp.weight', 5], ['blk.1.ffn_gate_exps.weight', 30], ['blk.2.attn_q.weight', 7], ['output.weight', 50]
  ]
  const { buf, dataStart, fileSize } = gguf(kv, tensors)
  const header = parseGgufHeader(buf, { tensors: true })
  assert.equal(header.dataStart, dataStart); assert.equal(header.tensors?.length, 8); ok('names and offsets are read, and where the data starts')
  assert.deepEqual(expertBytesPerBlock(header, fileSize, 3), [80, 30, 0]); ok('routed experts per block, not the shared expert or attention')
  assert.equal(embeddingBytes(header, fileSize), 100); ok('the token embedding stays on the host when there is an output tensor')
  assert.equal(unusedBlockBytes(header, fileSize, 2), 7); ok('the next-token-prediction block is counted as unused')
  const tied = gguf(kv, tensors.filter(([name]) => name !== 'output.weight'))
  assert.equal(embeddingBytes(parseGgufHeader(tied.buf, { tensors: true }), tied.fileSize), 0); ok('tied to the output, it saves nothing on the GPU')
  const ple = gguf(kv, [...tensors, ['per_layer_token_embd.weight', 60]])
  assert.equal(embeddingBytes(parseGgufHeader(ple.buf, { tensors: true }), ple.fileSize), 160); ok('a per-layer embedding table stays on the host as well')
  assert.equal(expertBytesPerBlock(parseGgufHeader(buf), fileSize, 3), null); ok('without the table, nothing is claimed')

  const dir = await mkdtemp(join(tmpdir(), 'moe-'))
  const file = join(dir, 'm.gguf')
  await writeFile(file, Buffer.concat([buf, Buffer.alloc(fileSize - buf.length)]))
  const meta = await readGgufMetadata(file)
  assert.deepEqual([meta.expertBytesPerBlock, meta.embeddingBytes, meta.unusedBytes], [[80, 30, 0], 100, 7]); ok('and a file read from disk carries all three')
  await rm(dir, { recursive: true, force: true })
}

console.log('\nthe plan moves offloaded experts from VRAM to system RAM')
{
  const meta = {
    fileSize: 200 * MiB, blockCount: 4, embeddingLength: 64, headCount: 4, headCountKv: 4, vocabSize: 0,
    expertCount: 8, expertUsedCount: 2, expertFeedForwardLength: 32, feedForwardLength: 32,
    expertBytesPerBlock: [10, 20, 30, 40].map((m) => m * MiB), embeddingBytes: 0
  } as unknown as GgufMetadata
  const plan = (gpuLayers: number, cpuMoeLayers: number) => planVram({ meta, gpuLayers, contextSize: 512, cacheTypeK: 'f16', cacheTypeV: 'f16', cpuMoeLayers }, null)
  assert.equal(plan(999, 0).weightsMiB, 200); ok('off: every weight on the GPU')
  assert.equal(plan(999, -1).weightsMiB, 100); assert.equal(plan(999, -1).expertsOnCpuMiB, 100); ok('every layer: all 100 MiB of experts move to RAM')
  assert.equal(plan(999, 2).expertsOnCpuMiB, 30); ok('the first two layers: their 10 + 20 MiB')
  // -ngl 2 offloads the last two blocks (2 and 3); experts of blocks 0-2 on the CPU overlap only in block 2.
  assert.equal(expertPlacement(meta, 2, 3).offGpuBytes, 30 * MiB); ok('with a partial offload, only experts of layers that were on the GPU leave it')
  assert.equal(plan(999, -1).moeBlocks, 4); ok('the plan says the model has experts, which is when the option is shown')
  const dense = { ...meta, expertCount: null, expertUsedCount: null, expertFeedForwardLength: null, expertBytesPerBlock: null } as unknown as GgufMetadata
  assert.equal(planVram({ meta: dense, gpuLayers: 999, contextSize: 512, cacheTypeK: 'f16', cacheTypeV: 'f16', cpuMoeLayers: -1 }, null).moeBlocks, null); ok('a dense model has none, and the setting changes nothing')
  const noTable = { ...meta, expertBytesPerBlock: null } as unknown as GgufMetadata
  assert.ok(expertPlacement(noTable, 4, -1).onCpuBytes > 0); ok('without the tensor table, the parameter share is the estimate')
}

console.log(`\n${n} assertions passed`)
