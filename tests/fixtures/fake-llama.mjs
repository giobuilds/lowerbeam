#!/usr/bin/env node
// Stand-in for llama-server: same CLI shape, same stderr strings (taken from the
// b6153 binary), same /health semantics (503 "Loading model" until resident).
import { createServer } from 'node:http'
const argv = process.argv.slice(2)
const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
const port = Number(get('--port'))
const model = get('--model')
const loadMs = Number(process.env.FAKE_LOAD_MS ?? 1500)
const host = get('--host') ?? '127.0.0.1'
const apiKey = get('--api-key') ?? process.env.LLAMA_API_KEY // as llama-server: the flag, or the environment

let ready = false
process.stderr.write(`srv    load_model: loading model '${model}'\n`)
createServer((req, res) => {
  if (req.url === '/health') {
    if (ready) { res.writeHead(200, {'content-type':'application/json'}); res.end('{"status":"ok"}') }
    else { res.writeHead(503, {'content-type':'application/json'}); res.end('{"error":{"code":503,"message":"Loading model"}}') }
    return
  }
  // As llama-server does: with --api-key, everything but /health wants the key.
  if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
    res.writeHead(401, {'content-type':'application/json'}); res.end('{"error":{"code":401,"message":"Invalid API Key"}}')
    return
  }
  if (req.url === '/props' && ready) {
    res.writeHead(200, {'content-type':'application/json'}); res.end('{"default_generation_settings":{"n_ctx":4096}}')
    return
  }
  // A reply with the server's timings: faster, and with drafts counted,
  // when launched with speculative decoding. A non-streaming caller still gets
  // that JSON. A streaming caller that leaves thinking on spends max_tokens on
  // reasoning_content and finishes for length with no reply, which is what a
  // thinking model does to a short cap. chat_template_kwargs.enable_thinking
  // set to false is the switch that writes the reply instead.
  if (req.url === '/v1/chat/completions' && req.method === 'POST' && ready) {
    const spec = argv.includes('--spec-type') || argv.includes('--model-draft')
    const timings = spec ? { predicted_per_second: 51, draft_n: 100, draft_n_accepted: 70 } : { predicted_per_second: 30 }
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body = {}
      try { body = raw ? JSON.parse(raw) : {} } catch { body = {} }
      if (body.stream !== true) {
        res.writeHead(200, {'content-type':'application/json'})
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], timings }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const thinkingOff = body.chat_template_kwargs && body.chat_template_kwargs.enable_thinking === false
      if (body.response_format) {
        const text = JSON.stringify({
          constraints: ['Fedora'],
          decisions: [{ chose: 'plain C', because: "don't need SDL" }],
          rejected: [],
          artifacts: ['gcc -o story engine.c'],
          openQuestions: []
        })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], timings })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      if (thinkingOff) {
        const text = 'The earlier turns settled the open questions.'
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], timings })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      const cap = typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : 8
      for (let i = 0; i < cap; i++) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'think ' } }] })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }], timings })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
    return
  }
  res.writeHead(404); res.end()
}).listen(port, host, () => {
  setTimeout(() => {
    process.stderr.write('main: model loaded\n')
    process.stderr.write(`main: HTTP server is listening, hostname: 127.0.0.1, port: ${port}, http threads: 4\n`)
    process.stderr.write(`main: server is listening on http://127.0.0.1:${port} - starting the main loop\n`)
    ready = true
  }, loadMs)
})
// Ignore SIGTERM if asked, to exercise the SIGKILL escalation.
if (process.env.FAKE_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {})
