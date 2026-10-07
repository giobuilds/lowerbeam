import assert from 'node:assert/strict'
import { planVram, recurrentStateBytes, speculationBytes, computeBufferBytes, kvCacheBytes, DRAFT_MAX } from '../../src/main/planner.js'
import { speculativeArgs } from '../../src/main/supervisor.js'
import { measureSpeculation } from '../../src/main/specMeasure.js'
import { canDraftFor } from '@shared/speculation.js'
import type { GgufMetadata } from '../../src/main/gguf.js'
import { DEFAULT_LAUNCH_CONFIG } from '@shared/types.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }
const MiB = 1024 * 1024

// #111: speculative decoding as a launch option, counted in the plan, and measured.
const bin = (flags: string[]) => ({ path: '/x', kind: 'unified' as const, argvPrefix: ['serve'], version: 't', flags, flashAttnStyle: 'value' as const, devices: [], label: 't', flagDocs: [] })
const cfg = { ...DEFAULT_LAUNCH_CONFIG, modelPath: '/m/9b.gguf' }

console.log('the launch')
{
  const typed = bin(['--spec-type', '--model-draft'])
  assert.deepEqual(speculativeArgs(cfg, typed), []); ok('off by default')
  assert.deepEqual(speculativeArgs({ ...cfg, speculative: 'mtp' }, typed), ['--spec-type', 'draft-mtp']); ok('the model’s own MTP head')
  assert.deepEqual(speculativeArgs({ ...cfg, speculative: 'ngram' }, typed), ['--spec-type', 'ngram-mod']); ok('an n-gram lookup')
  assert.deepEqual(speculativeArgs({ ...cfg, speculative: 'draft', draftModelPath: '/m/small.gguf' }, typed), ['--spec-type', 'draft-simple', '--model-draft', '/m/small.gguf']); ok('a draft model')
  assert.deepEqual(speculativeArgs({ ...cfg, speculative: 'draft', draftModelPath: null }, typed), []); ok('a draft mode with no model chosen is off')
  const old = bin(['--model-draft'])
  assert.deepEqual(speculativeArgs({ ...cfg, speculative: 'draft', draftModelPath: '/m/small.gguf' }, old), ['--model-draft', '/m/small.gguf']); assert.deepEqual(speculativeArgs({ ...cfg, speculative: 'mtp' }, old), []); ok('an older binary: a draft model only, nothing it would refuse')
}

console.log('\nwhich models can draft for which')
{
  const qwen = { vocabSize: 248320, tokenizerModel: 'gpt2', tokenizerPre: 'qwen35' }
  assert.equal(canDraftFor({ ...qwen }, qwen), null); ok('the same tokenizer: yes')
  assert.match(canDraftFor({ ...qwen, vocabSize: 49152 }, qwen)!, /49,152 tokens/); ok('another vocabulary: no, and says why')
  assert.match(canDraftFor({ ...qwen, tokenizerPre: 'llama-bpe' }, qwen)!, /splits text differently/); ok('the same size but another pre-tokenizer: no')
}

// Ornith 1.5 9B as its file states it, with the sizes the planner reads.
const nine: GgufMetadata = {
  path: '/m/9b.gguf', fileName: '9b.gguf', fileSize: 5780090816, architecture: 'qwen35', name: 'Ornith', blockCount: 33, contextLength: 262144, embeddingLength: 4096,
  headCount: 16, headCountKv: 4, keyLength: 256, valueLength: 256, quant: 'Q4_K_M', parameterCount: null, hasChatTemplate: true, vocabSize: 248320, isProjector: false,
  feedForwardLength: 12288, expertCount: null, expertUsedCount: null, expertFeedForwardLength: null, fullAttentionInterval: 4, nextnLayers: 1,
  ssm: { stateSize: 128, innerSize: 4096, groupCount: 16, timeStepRank: 32, convKernel: 4 }, unusedBytes: 144 * MiB, embeddingBytes: 545 * MiB
} as GgufMetadata

console.log('\nwhat it costs in VRAM')
{
  assert.equal(recurrentStateBytes(nine, 1) / MiB, 50.25); ok('the 9B’s recurrent state per sequence: 50.25 MiB, as llama.cpp reports it')
  assert.equal(recurrentStateBytes({ ...nine, ssm: null }, 1), 0); ok('none on a model without state-space blocks')
  const input = { meta: nine, gpuLayers: 999, contextSize: 16384, cacheTypeK: 'f16' as const, cacheTypeV: 'f16' as const, parallel: 1, computeProfile: 'modern' as const }
  const mtp = speculationBytes(input, { type: 'mtp' })
  const expected = 144 * MiB + kvCacheBytes(nine, 16384, 'f16', 'f16', 1)! + 50.25 * MiB * DRAFT_MAX + 2 * computeBufferBytes(nine, 512, 'modern')! * 0.65
  assert.equal(Math.round(mtp.bytes), Math.round(expected)); assert.ok(Math.abs(mtp.bytes / MiB - 567) < 30, `${mtp.bytes / MiB}`); ok(`MTP: head, its cache, ${DRAFT_MAX} more states, draft compute — ${Math.round(mtp.bytes / MiB)} MiB against the 567 llama.cpp reported`)
  assert.equal(speculationBytes(input, { type: 'ngram' }).bytes, 0); ok('an n-gram lookup costs nothing')
  const small = { ...nine, fileSize: 800 * MiB, blockCount: 24, nextnLayers: 0, unusedBytes: 0, ssm: null, fullAttentionInterval: null, embeddingBytes: 100 * MiB }
  const draft = speculationBytes(input, { type: 'draft', meta: small })
  const alone = planVram({ ...input, meta: small }, null)
  assert.equal(Math.round(draft.bytes / MiB), Math.round(alone.totalMiB - alone.backendOverheadMiB)); ok('a draft model: its own launch, without a second backend reserve')
  const base = planVram(input, null)
  const withMtp = planVram({ ...input, speculative: { type: 'mtp' } }, null)
  assert.equal(Math.round(withMtp.totalMiB - base.totalMiB), Math.round(mtp.bytes / MiB)); assert.ok(withMtp.notes.some((x) => x.startsWith('speculation: the model'))); ok('the plan adds it, and says what it is')
  assert.equal(planVram({ ...input, gpuLayers: 0, speculative: { type: 'mtp' } }, null).speculationMiB, 0); ok('nothing on the GPU when nothing is offloaded')
}

console.log('\nthe gain, measured')
{
  process.env['FAKE_LOAD_MS'] = '100'
  const shim = new URL('../fixtures/fake-llama.mjs', import.meta.url).pathname
  const steps: string[] = []
  const r = await measureSpeculation({ ...bin(['--spec-type']), path: shim, argvPrefix: [] }, { ...cfg, speculative: 'mtp' }, (s) => steps.push(s))
  assert.equal(r.without.code, 30); assert.equal(r.with.code, 51); assert.equal(r.with.prose, 51); ok('the same launch with and without it, the speed each reported')
  assert.equal(r.with.drafted, 200); assert.equal(r.with.accepted, 140); assert.equal(r.without.drafted, 0); ok('with the drafted and accepted tokens over both requests')
  assert.ok(steps.some((s) => s.startsWith('without speculation')) && steps.some((s) => s.startsWith('with mtp'))); ok('reporting progress as it goes')
  await assert.rejects(measureSpeculation(bin([]), cfg), /Choose a kind/); ok('nothing to measure when it is off')
}

console.log(`\n${n} assertions passed`)
