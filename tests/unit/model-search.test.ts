import assert from 'node:assert/strict'
import { distinctModels, modelFamily } from '../../src/main/downloads.js'
import type { HfModel } from '@shared/types.js'

let n = 0
const ok = (m: string) => {
  n++
  console.log('  ok', m)
}

const model = (id: string, downloads: number): HfModel => ({
  id,
  downloads,
  likes: 0,
  gated: false,
  lastModified: null
})

console.log('a model name, without the account or the gguf suffix')
{
  assert.equal(modelFamily('unsloth/Qwen3.8-27B-GGUF', true), 'qwen3.8-27b')
  assert.equal(modelFamily('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', true), 'qwen3.8-27b')
  assert.equal(modelFamily('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', true), 'huihui-qwen3.8-27b')
  assert.equal(modelFamily('Qwen/Qwen3-8B-GGUF', true), 'qwen3-8b')
  assert.equal(modelFamily('Qwen/Qwen3-4B-GGUF', true), 'qwen3-4b')
  assert.equal(modelFamily('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', false), 'qwen3.8-27b-uncensored')
  ok('fork words count on the browse page and stay when someone searched for them')
}

console.log('\nthe browse page keeps one of each model')
{
  const listed = distinctModels(
    [
      model('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 200),
      model('unsloth/Qwen3.8-27B-GGUF', 180),
      model('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 50),
      model('ggml-org/Qwen3.8-27B-GGUF', 40),
      model('Qwen/Qwen3-8B-GGUF', 90),
      model('Qwen/Qwen3-4B-GGUF', 70),
      model('ornith-ai/Ornith-1.5-9B-GGUF', 60),
      model('ornith-ai/Ornith-1.5-35B-A3B-GGUF', 55),
      model('ornith-ai/Ornith-1.5-35B-GGUF', 54),
      model('z-lab/Qwen3.8-27B-DFlash2-GGUF', 20),
      model('unsloth/GLM-5.3-Flash-GGUF', 40),
      model('peasantsmith/GLM-5.3-Flash-Maya-GGUF', 35),
      model('bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', 30)
    ],
    true
  ).map((item) => item.id)
  assert.deepEqual(listed, [
    'JonathanColetti/Qwen3.8-27B-Uncensored-GGUF',
    'Qwen/Qwen3-8B-GGUF',
    'Qwen/Qwen3-4B-GGUF',
    'ornith-ai/Ornith-1.5-9B-GGUF',
    'ornith-ai/Ornith-1.5-35B-A3B-GGUF',
    'ornith-ai/Ornith-1.5-35B-GGUF',
    'unsloth/GLM-5.3-Flash-GGUF',
    'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF'
  ])
  ok('one Qwen 27B, and the other sizes and families stay')
}

console.log('\na search keeps each uploader')
{
  const listed = distinctModels(
    [
      model('unsloth/X-GGUF', 100),
      model('bartowski/X-GGUF', 80),
      model('unsloth/X-GGUF', 50)
    ],
    false
  ).map((item) => item.id)
  assert.deepEqual(listed, ['unsloth/X-GGUF', 'bartowski/X-GGUF'])
  ok('bartowski and unsloth each keep a row, and the same repo twice is one')
}

console.log(`\n${n} assertions passed`)
