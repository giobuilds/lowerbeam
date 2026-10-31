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
import { matchGbnf } from './gbnfMatch.js'

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

/**
 * A grammar that allows one fenced call for these tools, or a final answer.
 *
 * Each tool name is tied to that tool's own arguments. A final answer may
 * contain backticks. A reply that opens a ```tool block and does not finish
 * the call is not a final answer.
 */
export function buildToolGrammar(tools: readonly ToolDefinition[]): string {
  const calls = tools.map((tool) => `call-${ruleName(tool.name)}`)
  const lines = [
    'root ::= tool-reply | final-reply',
    'tool-reply ::= "```tool\\n" call "\\n```"',
    `call ::= ${calls.join(' | ') || 'call-read'}`,
    ...tools.flatMap((tool) => callRules(tool)),
    // A code fence is allowed. ```tool is not, unless the whole reply is a finished call above.
    'final-reply ::= final-pieces',
    'final-pieces ::= final-chunk final-pieces | final-chunk | "`" | "``" | "```"',
    'final-chunk ::= [^`]+ | "`" [^`] | "``" [^`] | "```" not-tool',
    'not-tool ::= [^t] | "t" [^o] | "to" [^o] | "too" [^l] | "tool" [^ \\t\\n]',
    'ws ::= [ \\t\\n]*',
    'string ::= "\\"" string-char* "\\""',
    // JSON escapes only. A raw newline or other control character is not a string.
    'string-char ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" hex hex hex hex)',
    'hex ::= [0-9a-fA-F]',
    'integer ::= "-"? [0-9]+',
    'number ::= "-"? [0-9]+ ("." [0-9]+)?',
    'boolean ::= "true" | "false"'
  ]
  return lines.join('\n')
}

function callRules(tool: ToolDefinition): string[] {
  const name = ruleName(tool.name)
  const lines = [
    `call-${name} ::= "{" ws "\\"name\\"" ws ":" ws "\\"${escapeGbnf(tool.name)}\\"" ws "," ws "\\"arguments\\"" ws ":" ws ${name}-args ws "}"`,
    `${name}-args ::= ${argsRule(tool)}`
  ]
  const optional = optionalFields(tool)
  if (optional.length) lines.push(`${name}-opt ::= ${optional.join(' | ')}`)
  return lines
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
 * Whether a reply is one the grammar accepts, and which side of it.
 *
 * The decision is a GBNF match. The parser then says whether that match was
 * a call or a final answer.
 */
export function grammarFixture(grammar: string, reply: string, tools: readonly ToolDefinition[]): 'call' | 'final' | 'reject' {
  if (!matchGbnf(grammar, reply)) return 'reject'
  const parsed = parseTextToolCall(reply, tools)
  if (parsed.kind === 'answer') return 'final'
  if (parsed.kind === 'call') return 'call'
  return 'reject'
}

function argsRule(tool: ToolDefinition): string {
  const required = tool.parameters.required ?? []
  const optional = Object.keys(tool.parameters.properties).filter((key) => !required.includes(key))
  const name = ruleName(tool.name)
  const requiredBody = required.map((key) => fieldOf(tool, key)).join(' ws "," ws ')
  if (required.length === 0 && optional.length === 0) return '"{" ws "}"'
  if (optional.length === 0) return `"{" ws ${requiredBody} ws "}"`
  // No required key: the first optional stands alone, and further ones follow a comma.
  // A required key is already there, so each optional brings its own comma.
  const tail = required.length === 0 ? `(${name}-opt (ws "," ws ${name}-opt)*)?` : `(ws "," ws ${name}-opt)*`
  const body = [requiredBody, tail].filter(Boolean).join(' ')
  return `"{" ws ${body} ws "}"`
}

function optionalFields(tool: ToolDefinition): string[] {
  const required = tool.parameters.required ?? []
  return Object.keys(tool.parameters.properties)
    .filter((key) => !required.includes(key))
    .map((key) => fieldOf(tool, key))
}

function fieldOf(tool: ToolDefinition, key: string): string {
  const type = tool.parameters.properties[key]?.type ?? 'string'
  const value = type === 'integer' ? 'integer' : type === 'number' ? 'number' : type === 'boolean' ? 'boolean' : 'string'
  return `"\\"${key}\\"" ws ":" ws ${value}`
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
