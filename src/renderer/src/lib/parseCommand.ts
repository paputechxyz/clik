import type { CommandTree, CommandNode, Flag } from '../../../shared/types'

export interface ParsedCommand {
  selection: string[]
  flags: Record<string, unknown>
  positional: string[]
}

function coerceValue(f: Flag, raw: string): unknown {
  switch (f.type) {
    case 'bool':
      return raw !== 'false' && raw !== '0' && raw !== ''
    case 'int': {
      const n = parseInt(raw, 10)
      return Number.isNaN(n) ? raw : n
    }
    case 'float': {
      const n = parseFloat(raw)
      return Number.isNaN(n) ? raw : n
    }
    default:
      return raw
  }
}

function applyFlag(
  flag: Flag | undefined,
  inline: string | null,
  tokens: string[],
  i: number,
  flags: Record<string, unknown>
): number {
  if (!flag) return i + 1
  if (flag.type === 'bool') {
    flags[flag.name] = inline === null ? true : coerceValue(flag, inline)
    return i + 1
  }
  let raw: string
  let consumed: number
  if (inline !== null) {
    raw = inline
    consumed = i + 1
  } else if (i + 1 < tokens.length) {
    raw = tokens[i + 1]
    consumed = i + 2
  } else {
    return i + 1
  }
  if (flag.type === 'stringSlice') {
    const arr = Array.isArray(flags[flag.name]) ? [...(flags[flag.name] as string[])] : []
    arr.push(raw)
    flags[flag.name] = arr
  } else {
    flags[flag.name] = coerceValue(flag, raw)
  }
  return consumed
}

export function parseCommandTokens(tokens: string[], tree: CommandTree): ParsedCommand {
  const result: ParsedCommand = { selection: [], flags: {}, positional: [] }
  let node: CommandNode = tree.root
  let i = 0

  // walk subcommand path: consume leading non-flag tokens that match children
  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok.startsWith('-')) break
    const child = node.children.find((c) => c.name === tok)
    if (!child) break
    node = child
    result.selection.push(tok)
    i++
  }

  const available = [...node.flags, ...node.inheritedFlags]
  const findByLong = (name: string): Flag | undefined => available.find((f) => f.name === name)
  const findByShort = (s: string): Flag | undefined => available.find((f) => f.shorthand === s)

  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok === '--') {
      i++
      while (i < tokens.length) result.positional.push(tokens[i++])
      break
    }
    if (tok.startsWith('--')) {
      const body = tok.slice(2)
      let name: string
      let inline: string | null = null
      const eq = body.indexOf('=')
      if (eq >= 0) {
        name = body.slice(0, eq)
        inline = body.slice(eq + 1)
      } else {
        name = body
      }
      i = applyFlag(findByLong(name), inline, tokens, i, result.flags)
    } else if (tok.startsWith('-') && tok.length >= 2 && tok !== '-') {
      const body = tok.slice(1)
      let short: string
      let inline: string | null = null
      const eq = body.indexOf('=')
      if (eq >= 0) {
        short = body.slice(0, eq)
        inline = body.slice(eq + 1)
      } else {
        short = body
      }
      i = applyFlag(findByShort(short), inline, tokens, i, result.flags)
    } else {
      result.positional.push(tok)
      i++
    }
  }

  return result
}
