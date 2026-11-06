import assert from 'node:assert/strict'
import { distinctModels, isDraftCompanionName, modelFamily, modelSearchRequest, withoutDraftRepos } from '../../src/main/downloads.js'
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

console.log('\nMTP heads and speculative drafts are not chat models')
{
  assert.equal(isDraftCompanionName('Qwen3.8-35B-A3B-Q4_K_M.gguf'), false)
  assert.equal(isDraftCompanionName('mmproj-Qwen3.8-35B-A3B-Q8_0.gguf'), false)
  assert.equal(isDraftCompanionName('empero-ai/Qwen3.8-35B-A3B-Distill-GGUF'), false)
  assert.equal(isDraftCompanionName('Qwen3.8-35B-A3B-Q4_K_M-mtp.gguf'), true)
  assert.equal(isDraftCompanionName('Qwen3.8-35B-A3B-Distill-MTP-APEX-I-MiniPlus-V2.1-Q8_0.gguf'), true)
  assert.equal(isDraftCompanionName('IsValorum/Qwen3.8-35B-A3B-Distill-MTP-APEX-I-MiniPlus-V2.1-GGUF'), true)
  assert.equal(isDraftCompanionName('foo-draft-Q4_K_M.gguf'), true)
  assert.equal(isDraftCompanionName('draftQ4_K_M.gguf'), true)
  assert.equal(isDraftCompanionName('draft/Model-Q4_K_M.gguf'), true)
  assert.equal(isDraftCompanionName('Model-DFlash2-Q4_K_M.gguf'), true)
  assert.equal(isDraftCompanionName('z-lab/Qwen3.8-27B-DFlash2-GGUF'), true)
  assert.equal(isDraftCompanionName('someone/Qwen3.8-35B-A3B-Coder-Abliterated-GGUF'), false)
  ok('mtp, draft and dflash names are companions; a chat quant, a projector and an abliterated finetune are not')
}

console.log('\nthe browse page must not pick the draft as the model')
{
  const repos = [
    model('IsValorum/Qwen3.8-35B-A3B-Distill-MTP-APEX-GGUF', 500),
    model('empero-ai/Qwen3.8-35B-A3B-Distill-GGUF', 100),
    model('z-lab/Qwen3.8-27B-DFlash2-GGUF', 400),
    model('unsloth/Qwen3.8-27B-GGUF', 80)
  ]
  assert.deepEqual(distinctModels(repos, true).map((item) => item.id), [
    'IsValorum/Qwen3.8-35B-A3B-Distill-MTP-APEX-GGUF',
    'z-lab/Qwen3.8-27B-DFlash2-GGUF'
  ])
  assert.deepEqual(distinctModels(withoutDraftRepos(repos), true).map((item) => item.id), [
    'empero-ai/Qwen3.8-35B-A3B-Distill-GGUF',
    'unsloth/Qwen3.8-27B-GGUF'
  ])
  ok('without the filter the most-downloaded draft wins the row; with it, the chat model does')
}

console.log('\na search can ask for the drafts')
{
  assert.deepEqual(modelSearchRequest('qwen'), { query: 'qwen', chatOnly: true })
  assert.deepEqual(modelSearchRequest({ query: 'qwen', chatOnly: false }), { query: 'qwen', chatOnly: false })
  assert.equal(modelSearchRequest({ query: 'qwen' }).chatOnly, true)
  assert.equal(modelSearchRequest(null).chatOnly, true)
  ok('chat-runnable stays on unless the request turns it off')
}

console.log(`\n${n} assertions passed`)
