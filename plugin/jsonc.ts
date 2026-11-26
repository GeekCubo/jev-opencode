// Minimal JSONC reader and targeted editor for OpenCode configuration files.
// Parses JSON with // and /* */ comments and trailing commas, records the text
// span of every value, and edits by splicing only the affected spans, so
// comments, formatting and every unrelated property stay byte-for-byte intact.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

export interface Node {
  type: "object" | "array" | "string" | "number" | "boolean" | "null"
  start: number
  end: number // exclusive
  value?: JsonValue
  /** object: properties in source order (key span start, value node) */
  props?: { key: string; keyStart: number; value: Node }[]
  items?: Node[]
}

export class JsoncError extends Error {
  constructor(message: string, public offset: number) {
    super(message)
  }
}

export function parseTree(text: string): Node {
  let i = 0
  const fail = (msg: string): never => {
    const before = text.slice(0, i)
    const line = before.split("\n").length
    const col = i - before.lastIndexOf("\n")
    throw new JsoncError(`${msg} at line ${line}, column ${col}`, i)
  }
  const ws = () => {
    for (;;) {
      const c = text[i]
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\uFEFF") i++
      else if (c === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++
      } else if (c === "/" && text[i + 1] === "*") {
        const close = text.indexOf("*/", i + 2)
        if (close < 0) fail("unterminated block comment")
        i = close + 2
      } else return
    }
  }
  const str = (): string => {
    const start = i
    i++
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i++
      else if (text[i] === "\n") fail("unterminated string")
      i++
    }
    if (i >= text.length) fail("unterminated string")
    i++
    try {
      return JSON.parse(text.slice(start, i))
    } catch {
      i = start
      return fail("invalid string")
    }
  }
  const value = (): Node => {
    ws()
    const start = i
    const c = text[i]
    if (c === "{") {
      i++
      const props: Node["props"] = []
      const obj: Record<string, JsonValue> = {}
      ws()
      while (text[i] !== "}") {
        if (text[i] !== '"') fail("expected a property name")
        const keyStart = i
        const key = str()
        ws()
        if (text[i] !== ":") fail("expected ':'")
        i++
        const v = value()
        props.push({ key, keyStart, value: v })
        obj[key] = v.value!
        ws()
        if (text[i] === ",") (i++, ws())
        else if (text[i] !== "}") fail("expected ',' or '}'")
      }
      i++
      return { type: "object", start, end: i, value: obj, props }
    }
    if (c === "[") {
      i++
      const items: Node[] = []
      ws()
      while (text[i] !== "]") {
        items.push(value())
        ws()
        if (text[i] === ",") (i++, ws())
        else if (text[i] !== "]") fail("expected ',' or ']'")
      }
      i++
      return { type: "array", start, end: i, value: items.map(n => n.value!), items }
    }
    if (c === '"') {
      const s = str()
      return { type: "string", start, end: i, value: s }
    }
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64))
    if (!m) return fail("unexpected token")
    i += m[0].length
    const lit = m[0]
    if (lit === "true" || lit === "false") return { type: "boolean", start, end: i, value: lit === "true" }
    if (lit === "null") return { type: "null", start, end: i, value: null }
    return { type: "number", start, end: i, value: Number(lit) }
  }
  const root = value()
  ws()
  if (i < text.length) fail("unexpected content after the configuration")
  return root
}

export const parse = (text: string): JsonValue => parseTree(text).value!

export const prop = (node: Node | undefined, key: string): Node | undefined =>
  node?.type === "object" ? node.props!.find(p => p.key === key)?.value : undefined

const lineIndent = (text: string, offset: number) => {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart))![0]
}

/** Indentation unit used by the file (first indented line), default two spaces. */
const indentUnit = (text: string) => /\n([ \t]+)\S/.exec(text)?.[1] ?? "  "

/**
 * Text to insert a new property at the start of an object node. Inserting first
 * avoids touching trailing commas or comments at the end of the object.
 */
export function insertProperty(text: string, obj: Node, key: string, val: JsonValue): { at: number; insert: string } {
  const unit = indentUnit(text)
  const first = obj.props![0]
  const multiline = text.slice(obj.start, obj.end).includes("\n")
  const inner = first && text.lastIndexOf("\n", first.keyStart) > obj.start
    ? lineIndent(text, first.keyStart)
    : lineIndent(text, obj.start) + unit
  const rendered = render(val, inner, unit)
  const entry = `${JSON.stringify(key)}: ${rendered}`
  const empty = obj.props!.length === 0
  if (!multiline && empty) return { at: obj.start + 1, insert: `\n${inner}${entry}\n${lineIndent(text, obj.start)}` }
  if (!multiline) return { at: obj.start + 1, insert: ` ${entry},` }
  return { at: obj.start + 1, insert: `\n${inner}${entry}${empty ? "" : ","}` }
}

/** JSON rendering at a given indentation level (keeps the file's indent unit). */
export function render(val: JsonValue, indent: string, unit: string): string {
  const s = JSON.stringify(val, null, unit)
  return s.split("\n").map((l, n) => (n === 0 ? l : indent + l)).join("\n")
}

export interface Splice {
  at: number
  remove: number
  insert: string
}

export function applySplices(text: string, edits: Splice[]): string {
  const sorted = [...edits].sort((a, b) => b.at - a.at)
  for (let k = 1; k < sorted.length; k++)
    if (sorted[k]!.at + sorted[k]!.remove > sorted[k - 1]!.at) throw new Error("overlapping configuration edits")
  let out = text
  for (const e of sorted) out = out.slice(0, e.at) + e.insert + out.slice(e.at + e.remove)
  return out
}

export const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
const sortKeys = (v: any): any =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]))
    : v
