/**
 * Constraining what a model may write: a JSON schema, or a GBNF grammar.
 *
 * llama-server turns either into a grammar and decodes under it, so the reply
 * cannot be anything but what the constraint allows. It can still be wrong;
 * it cannot ramble, drift out of format, or answer something else. A small
 * model that is poor at writing to a format can be adequate at filling one.
 *
 * Checked here before a request is sent, so a typo is a message beside the
 * editor rather than a failed request after the model has loaded the prompt.
 */

export type OutputMode = 'text' | 'json' | 'grammar'

/** What a conversation asks of its replies; the text of whichever constraint is chosen is kept for both. */
export interface OutputSetting {
  mode: OutputMode
  schema: string
  grammar: string
}

export const DEFAULT_OUTPUT: OutputSetting = { mode: 'text', schema: '', grammar: '' }

/** A checked constraint, ready to put in a request. */
export type OutputConstraint = { kind: 'json'; schema: Record<string, unknown> } | { kind: 'grammar'; grammar: string }

/** Keys a JSON schema has at its top level; one of them has to be there for it to describe anything. */
const SCHEMA_KEYS = ['type', 'properties', 'items', 'enum', 'const', 'oneOf', 'anyOf', 'allOf', '$ref', 'required']

export function checkSchema(text: string): { ok: true; schema: Record<string, unknown> } | { ok: false; error: string } {
  if (!text.trim()) return { ok: false, error: 'The schema is empty.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `Not valid JSON: ${(err as Error).message}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, error: 'A JSON schema is an object, such as {"type": "object", "properties": {…}}.' }
  const schema = parsed as Record<string, unknown>
  if (!SCHEMA_KEYS.some((k) => k in schema)) return { ok: false, error: `It does not describe anything: give it a "type", "properties", "enum" or one of ${SCHEMA_KEYS.slice(3).join(', ')}.` }
  if ('type' in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const known = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
    const bad = types.find((t) => typeof t !== 'string' || !known.includes(t))
    if (bad !== undefined) return { ok: false, error: `"type" ${JSON.stringify(bad)} is not a JSON Schema type (${known.join(', ')}).` }
  }
  return { ok: true, schema }
}

/**
 * A GBNF grammar, checked for what is easy to get wrong by hand: a root rule,
 * rules written as `name ::= …`, and quotes and brackets that close. The
 * server parses it properly and reports anything else.
 */
export function checkGrammar(text: string): { ok: true; grammar: string } | { ok: false; error: string } {
  if (!text.trim()) return { ok: false, error: 'The grammar is empty.' }
  const rules = text.split('\n').filter((l) => /^\s*[A-Za-z][A-Za-z0-9-]*\s*::=/.test(l)).map((l) => l.split('::=')[0]!.trim())
  if (!rules.includes('root')) return { ok: false, error: 'A grammar needs a rule called root, such as root ::= "yes" | "no".' }
  let depth = 0
  let inString = false
  let inClass = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '\\') {
      i++
      continue
    }
    if (inString) {
      if (c === '"') inString = false
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '#') {
      const end = text.indexOf('\n', i)
      i = end < 0 ? text.length : end
    } else if (c === '"') inString = true
    else if (c === '[') inClass = true
    else if (c === '(') depth++
    else if (c === ')' && --depth < 0) return { ok: false, error: 'A ")" closes nothing.' }
  }
  if (inString) return { ok: false, error: 'A quoted string is not closed.' }
  if (inClass) return { ok: false, error: 'A [character class] is not closed.' }
  if (depth > 0) return { ok: false, error: 'A "(" is not closed.' }
  return { ok: true, grammar: text }
}

/** The constraint a setting asks for, checked; null for free text. */
export function outputConstraint(setting: OutputSetting | undefined): { ok: true; constraint: OutputConstraint | null } | { ok: false; error: string } {
  if (!setting || setting.mode === 'text') return { ok: true, constraint: null }
  if (setting.mode === 'json') {
    const r = checkSchema(setting.schema)
    return r.ok ? { ok: true, constraint: { kind: 'json', schema: r.schema } } : r
  }
  const r = checkGrammar(setting.grammar)
  return r.ok ? { ok: true, constraint: { kind: 'grammar', grammar: r.grammar } } : r
}

/**
 * The request fields for a constraint, in the OpenAI form for a schema and
 * llama-server's own for a grammar — with thinking off. A thinking model
 * starts its reply in a reasoning block, and llama.cpp then files the
 * constrained text under reasoning, leaving the reply empty: measured on
 * Ornith-1.5-9B, a yes/no grammar answered "no" as reasoning and nothing as
 * content, and a schema filled placeholders. With thinking off it answered
 * "yes" and {"name": "Ada Lovelace", "born": 1815}. A template without the
 * switch ignores it.
 */
export function constraintFields(c: OutputConstraint | null | undefined): Record<string, unknown> {
  if (!c) return {}
  const thinkingOff = { chat_template_kwargs: { enable_thinking: false } }
  return c.kind === 'json'
    ? { response_format: { type: 'json_schema', json_schema: { name: 'reply', schema: c.schema } }, ...thinkingOff }
    : { grammar: c.grammar, ...thinkingOff }
}
