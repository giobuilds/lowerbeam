#!/usr/bin/env node
/**
 * A llama-server in router mode, as far as the supervisor can tell: reads
 * --models-preset and --models-max, answers /health, /models, /models/load,
 * /props?model= and chat requests that name a model, and evicts the least
 * recently loaded model past the limit. Loading takes a moment, as it does.
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const port = Number(arg('--port'))
const max = Number(arg('--models-max') ?? 4)
const key = arg('--api-key') ?? process.env.LLAMA_API_KEY
const presetText = readFileSync(arg('--models-preset'), 'utf8')
const presets = new Map()
let current = null
for (const line of presetText.split('\n')) {
  const section = line.match(/^\[(.+)\]$/)
  if (section) presets.set((current = section[1]), {})
  const kv = line.match(/^([\w-]+) = (.*)$/)
  if (kv && current) presets.get(current)[kv[1]] = kv[2]
}
const state = new Map([...presets.keys()].map((id) => [id, 'unloaded']))
const order = []
const load = (id) => {
  if (state.get(id) !== 'unloaded') return
  state.set(id, 'loading')
  setTimeout(() => {
    state.set(id, 'loaded')
    order.push(id)
    while (order.length > max) state.set(order.shift(), 'unloaded')
  }, 200)
}
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/health') return json(res, 200, { status: 'ok' })
  if (key && req.headers.authorization !== `Bearer ${key}`) return json(res, 401, { error: { message: 'Invalid API Key' } })
  if (url.pathname === '/preset') {
    res.writeHead(200)
    return res.end(presetText)
  }
  if (url.pathname === '/models') {
    return json(res, 200, { data: [...state].map(([id, value]) => ({ id, source: 'preset', status: { value } })) })
  }
  if (url.pathname === '/props') {
    const id = url.searchParams.get('model')
    if (!id) return json(res, 200, { role: 'router' })
    if (state.get(id) !== 'loaded') return json(res, 400, { error: { message: 'model is not loaded' } })
    const p = presets.get(id)
    return json(res, 200, {
      default_generation_settings: { n_ctx: Number(p['ctx-size'] ?? 4096) / Number(p.parallel ?? 1) },
      chat_template_caps: { supports_tools: id !== 'notools', supports_tool_calls: id !== 'notools' },
      modalities: { vision: 'mmproj' in p }
    })
  }
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    if (url.pathname === '/models/load') {
      const { model } = JSON.parse(raw)
      if (!state.has(model)) return json(res, 400, { error: { message: `model '${model}' not found` } })
      load(model)
      return json(res, 200, { success: true })
    }
    return json(res, 404, {})
  })
}).listen(port, '127.0.0.1')
