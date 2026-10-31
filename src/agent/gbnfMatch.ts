/**
 * Whether a string is one a GBNF grammar accepts.
 *
 * Enough of the grammar language to check the tool grammar this app builds:
 * rules, literals, character classes, groups, alternatives and repeats.
 * It is a matcher for tests and for the fixture, not the server's decoder.
 */

type Node =
  | { kind: 'lit'; text: string }
  | { kind: 'class'; negate: boolean; ranges: Array<[number, number]> }
  | { kind: 'ref'; name: string }
  | { kind: 'seq'; items: Node[] }
  | { kind: 'alt'; items: Node[] }
  | { kind: 'rep'; item: Node; min: number; max: number }

const MAX_STEPS = 200_000

export function matchGbnf(grammar: string, input: string): boolean {
  const rules = parseGrammar(grammar)
  const root = rules.get('root')
  if (!root) return false
  const fuel = { n: 0 }
  return ends(root, input, 0, rules, fuel).includes(input.length)
}

function parseGrammar(grammar: string): Map<string, Node> {
  const rules = new Map<string, Node>()
  for (const line of grammar.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('::=')
    if (at < 0) continue
    const name = trimmed.slice(0, at).trim()
    rules.set(name, parseAlt(trimmed.slice(at + 3).trim()))
  }
  return rules
}

function parseAlt(text: string): Node {
  const items: Node[] = []
  let rest = text
  while (rest.length) {
    const split = splitTop(rest, '|')
    items.push(parseSeq(split.head.trim()))
    rest = split.rest.trim()
  }
  return items.length === 1 ? items[0]! : { kind: 'alt', items }
}

function parseSeq(text: string): Node {
  const items: Node[] = []
  let i = 0
  while (i < text.length) {
    while (text[i] === ' ' || text[i] === '\t') i++
    if (i >= text.length) break
    const atom = readAtom(text, i)
    i = atom.next
    let node = atom.node
    if (text[i] === '?' || text[i] === '*' || text[i] === '+') {
      const mark = text[i]
      node = {
        kind: 'rep',
        item: node,
        min: mark === '+' ? 1 : 0,
        max: mark === '?' ? 1 : 10_000
      }
      i++
    }
    items.push(node)
  }
  if (items.length === 0) return { kind: 'lit', text: '' }
  return items.length === 1 ? items[0]! : { kind: 'seq', items }
}

function readAtom(text: string, i: number): { node: Node; next: number } {
  const c = text[i]
  if (c === '"') {
    const lit = readString(text, i)
    return { node: { kind: 'lit', text: lit.text }, next: lit.next }
  }
  if (c === '[') {
    const cls = readClass(text, i)
    return { node: { kind: 'class', negate: cls.negate, ranges: cls.ranges }, next: cls.next }
  }
  if (c === '(') {
    const close = matchClose(text, i)
    return { node: parseAlt(text.slice(i + 1, close)), next: close + 1 }
  }
  const name = /^[A-Za-z][A-Za-z0-9-]*/.exec(text.slice(i))
  if (!name) throw new Error(`Cannot read a grammar atom at ${JSON.stringify(text.slice(i, i + 20))}`)
  return { node: { kind: 'ref', name: name[0] }, next: i + name[0].length }
}

function splitTop(text: string, mark: string): { head: string; rest: string } {
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
    if (c === '"') inString = true
    else if (c === '[') inClass = true
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === mark && depth === 0) return { head: text.slice(0, i), rest: text.slice(i + 1) }
  }
  return { head: text, rest: '' }
}

function matchClose(text: string, open: number): number {
  let depth = 0
  let inString = false
  let inClass = false
  for (let i = open; i < text.length; i++) {
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
    if (c === '"') inString = true
    else if (c === '[') inClass = true
    else if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error('A grammar group did not close.')
}

function readString(text: string, open: number): { text: string; next: number } {
  let out = ''
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i]!
    if (c === '\\') {
      const n = text[i + 1] ?? ''
      const named: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"' }
      out += named[n] ?? n
      i++
      continue
    }
    if (c === '"') return { text: out, next: i + 1 }
    out += c
  }
  throw new Error('A grammar string did not close.')
}

function readClass(text: string, open: number): { negate: boolean; ranges: Array<[number, number]>; next: number } {
  let i = open + 1
  const negate = text[i] === '^'
  if (negate) i++
  const ranges: Array<[number, number]> = []
  while (i < text.length && text[i] !== ']') {
    const start = readClassChar(text, i)
    i = start.next
    if (text[i] === '-' && text[i + 1] !== ']') {
      const end = readClassChar(text, i + 1)
      ranges.push([start.code, end.code])
      i = end.next
    } else {
      ranges.push([start.code, start.code])
    }
  }
  return { negate, ranges, next: i + 1 }
}

function readClassChar(text: string, i: number): { code: number; next: number } {
  if (text[i] !== '\\') return { code: text.codePointAt(i) ?? 0, next: i + 1 }
  const n = text[i + 1] ?? ''
  if (n === 'x') {
    const hex = text.slice(i + 2, i + 4)
    return { code: Number.parseInt(hex, 16), next: i + 4 }
  }
  const named: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '-': '-', ']': ']' }
  return { code: (named[n] ?? n).codePointAt(0) ?? 0, next: i + 2 }
}

function ends(node: Node, input: string, pos: number, rules: Map<string, Node>, fuel: { n: number }): number[] {
  if (fuel.n++ > MAX_STEPS) return []
  if (node.kind === 'lit') return input.startsWith(node.text, pos) ? [pos + node.text.length] : []
  if (node.kind === 'class') {
    if (pos >= input.length) return []
    const code = input.codePointAt(pos) ?? 0
    const width = code > 0xffff ? 2 : 1
    const hit = node.ranges.some(([from, to]) => code >= from && code <= to)
    return hit !== node.negate ? [pos + width] : []
  }
  if (node.kind === 'ref') {
    const rule = rules.get(node.name)
    return rule ? ends(rule, input, pos, rules, fuel) : []
  }
  if (node.kind === 'alt') {
    const out: number[] = []
    for (const item of node.items) out.push(...ends(item, input, pos, rules, fuel))
    return [...new Set(out)]
  }
  if (node.kind === 'seq') {
    let positions = [pos]
    for (const item of node.items) {
      const next: number[] = []
      for (const at of positions) next.push(...ends(item, input, at, rules, fuel))
      positions = [...new Set(next)]
      if (positions.length === 0) return []
    }
    return positions
  }
  const reached = new Set<number>()
  if (node.min === 0) reached.add(pos)
  let layer = [pos]
  const cap = node.max
  for (let count = 1; count <= cap && layer.length; count++) {
    const next: number[] = []
    for (const at of layer) {
      for (const end of ends(node.item, input, at, rules, fuel)) {
        if (end > at) next.push(end)
      }
    }
    layer = [...new Set(next)]
    if (count >= node.min) for (const end of layer) reached.add(end)
    if (layer.length === 0) break
  }
  return [...reached]
}
