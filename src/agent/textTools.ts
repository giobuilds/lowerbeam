/**
 * Tool calls for a model whose chat template has none.
 *
 * The tools are described in the prompt, and a grammar lets the server
 * emit only a fenced call or a final answer. One call per reply.
 *
 * The idea is Goose's tool emulation, Continue's system-message tools and
 * OpenHands' function-call converter. This is a new implementation.
 */
import type { ToolDefinition } from '@shared/types.js'
import type { StreamedToolCall } from '@shared/chatClient.js'

export type ToolFormat = 'native' | 'text'

export interface ParsedToolCall {
  kind: 'call'
  call: StreamedToolCall
}

export interface ParsedAnswer {
  kind: 'answer'
  answer: string
}

export interface ParsedInvalid {
  kind: 'invalid'
  reason: string
}

const FENCE = /```tool\s*\n([\s\S]*?)\n```/

/**
 * The section added to the system prompt in text mode.
 *
 * It names every tool and shows one call, so the grammar is not the only
 * thing telling the model the shape.
 */
export function renderToolPrompt(tools: readonly ToolDefinition[]): string {
  const lines = [
    'You have no built-in tool calling. To use a tool, reply with exactly one fenced block tagged tool and nothing else:',
    '```tool',
    '{"name": "read", "arguments": {"path": "src/app.ts"}}',
    '```',
    'The name must be one of the tools below. To answer, reply in plain prose and do not open a tool block.',
    ''
  ]
  for (const tool of tools) {
    const props = Object.entries(tool.parameters.properties)
      .map(([key, spec]) => `${key}: ${spec.type}${tool.parameters.required?.includes(key) ? '' : '?'}`)
      .join(', ')
    lines.push(`- ${tool.name}(${props}) — ${tool.description}`)
  }
  return lines.join('\n')
}

/** A grammar that allows one fenced call for these tools, or a final answer. */
export function buildToolGrammar(tools: readonly ToolDefinition[]): string {
  const names = tools.map((tool) => `"${escapeGbnf(tool.name)}"`).join(' | ')
  const argRules = tools.map((tool) => `${ruleName(tool.name)}-args ::= ${argsRule(tool)}`)
  return [
    'root ::= tool-reply | final-reply',
    'tool-reply ::= "```tool\\n" call "\\n```"',
    `call ::= "{" ws "\\"name\\"" ws ":" ws name-value ws "," ws "\\"arguments\\"" ws ":" ws arguments "}"`,
    `name-value ::= ${names || '"read"'}`,
    `arguments ::= ${tools.map((tool) => `${ruleName(tool.name)}-args`).join(' | ') || '"{" ws "}"'}`,
    ...argRules,
    'final-reply ::= final-char+',
    'final-char ::= [^`]',
    'object-key ::= "\\"" [a-z_]+ "\\""',
    'ws ::= [ \\t\\n]*',
    'string ::= "\\"" ([^"\\\\] | "\\\\" .)* "\\""',
    'number ::= "-"? [0-9]+ ("." [0-9]+)?',
    'boolean ::= "true" | "false"'
  ].join('\n')
}

/** The same shape the loop already executes, or a final answer, or a refusal. */
export function parseTextToolCall(reply: string, tools: readonly ToolDefinition[]): ParsedToolCall | ParsedAnswer | ParsedInvalid {
  const fence = FENCE.exec(reply)
  if (!fence) {
    const text = reply.trim()
    if (!text) return { kind: 'invalid', reason: 'The reply was empty.' }
    if (reply.includes('```tool')) return { kind: 'invalid', reason: 'The tool block did not close.' }
    return { kind: 'answer', answer: text }
  }
  let body: unknown
  try {
    body = JSON.parse(fence[1]!)
  } catch {
    return { kind: 'invalid', reason: 'The tool block was not JSON.' }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'invalid', reason: 'The tool block was not an object.' }
  const record = body as { name?: unknown; arguments?: unknown }
  const name = typeof record.name === 'string' ? record.name : ''
  const tool = tools.find((item) => item.name === name)
  if (!tool) return { kind: 'invalid', reason: `There is no tool called ${name || '(missing)'}.` }
  const args = record.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { kind: 'invalid', reason: 'The tool call needs an arguments object.' }
  const given = args as Record<string, unknown>
  for (const key of tool.parameters.required ?? []) {
    if (given[key] === undefined || given[key] === '') return { kind: 'invalid', reason: `${name} needs ${key}.` }
  }
  for (const [key, value] of Object.entries(given)) {
    const spec = tool.parameters.properties[key]
    if (!spec) continue
    if (!valueMatches(spec.type, value)) return { kind: 'invalid', reason: `${name}.${key} should be a ${spec.type}.` }
  }
  return { kind: 'call', call: { id: 'text-tool', name, argumentsJson: JSON.stringify(given) } }
}

/**
 * Whether a reply is one the grammar's fixtures allow.
 *
 * This checks the grammar text and the reply together: an unknown name or a
 * missing required argument is rejected, and prose with no tool block is a
 * final answer. It is not a full GBNF parser; llama-server is.
 */
export function grammarFixture(grammar: string, reply: string, tools: readonly ToolDefinition[]): 'call' | 'final' | 'reject' {
  if (!grammar.includes('root ::=') || !grammar.includes('tool-reply') || !grammar.includes('final-reply')) return 'reject'
  const parsed = parseTextToolCall(reply, tools)
  if (parsed.kind === 'answer') return reply.includes('`') ? 'reject' : 'final'
  if (parsed.kind === 'invalid') return 'reject'
  if (!grammar.includes(`"${parsed.call.name}"`)) return 'reject'
  const tool = tools.find((item) => item.name === parsed.call.name)!
  for (const key of tool.parameters.required ?? []) {
    if (!grammar.includes(key)) return 'reject'
  }
  return 'call'
}

function argsRule(tool: ToolDefinition): string {
  const required = tool.parameters.required ?? []
  const optional = Object.keys(tool.parameters.properties).filter((key) => !required.includes(key))
  const field = (key: string): string => {
    const type = tool.parameters.properties[key]?.type ?? 'string'
    const value = type === 'number' || type === 'integer' ? 'number' : type === 'boolean' ? 'boolean' : 'string'
    return `"\\"${key}\\"" ws ":" ws ${value}`
  }
  if (required.length === 0 && optional.length === 0) return '"{" ws "}"'
  const head = required.map(field).join(' ws "," ws ')
  const tail = optional.map((key) => `(ws "," ws ${field(key)})?`).join(' ')
  const body = [head, tail].filter(Boolean).join(' ')
  return `"{" ws ${body} ws "}"`
}

function ruleName(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, '-')
}

function escapeGbnf(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function valueMatches(type: string, value: unknown): boolean {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number' || type === 'integer') return typeof value === 'number'
  if (type === 'boolean') return typeof value === 'boolean'
  return true
}
