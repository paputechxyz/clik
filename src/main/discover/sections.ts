// Splitting a help body into named sections is the one thing every CLI's help
// has in common; what varies is the layout *inside* a section, which is the
// business of ./dialects. Kept in its own module so a dialect can sectionise the
// root help while deciding whether it recognises a CLI, without importing the
// parser that consumes dialects.

// Strip ANSI escape codes (gcloud and other CLIs embed colour/formatting codes).
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// Cobra/kubectl/docker print section headers in Title Case WITH a trailing
// colon ("Usage:", "Available Commands:", "Basic Commands (Beginner):"). The
// gh CLI prints them in ALL UPPERCASE with NO colon ("USAGE", "CORE COMMANDS",
// "FLAGS"). Match both shapes: either a Title-Case line ending in a colon, or
// an all-uppercase line (colon optional).
// The all-caps alternative allows `&` between words so SDKMAN's
// "SUBCOMMANDS & QUALIFIERS" section header is recognised, and allows leading
// whitespace because glab indents its whole help body by two spaces ("  USAGE",
// "  COMMANDS", "  FLAGS"). Indentation stays off the Title-Case alternative:
// a capitalised, colon-terminated indented line is ordinary help prose far more
// often than it is a section header.
export const HEADER_RE =
  /^[A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,3}(?:\s*\([^)]*\))?:\s*$|^\s*[A-Z][A-Z]+(?:\s+[A-Z&]+){0,3}:?\s*$|^<[A-Z][A-Za-z]+>\s*$/

export interface HelpSections {
  /** Every line of the body, ANSI stripped and CRLF normalised. */
  lines: string[]
  /**
   * The prose before the first section header, still carrying its original
   * indentation — dedent() needs it to find the indent every line shares.
   */
  intro: string
  /** Section bodies, keyed by the header with its trailing colon removed. */
  sections: Map<string, string[]>
  /** The usage header as the CLI spelled it ("Usage" / "USAGE"), if any. */
  usageHeader?: string
  /** The usage synopsis line, from the usage section or a bare "usage: …" line. */
  usageLine: string
}

export function sectionise(text: string): HelpSections {
  const lines = stripAnsi(text.replace(/\r\n/g, '\n')).split('\n')
  let headerIdx = lines.findIndex((l) => HEADER_RE.test(l))
  if (headerIdx === -1) headerIdx = lines.length
  const intro = lines.slice(0, headerIdx).join('\n')

  const sections = new Map<string, string[]>()
  let cur = ''
  for (let i = headerIdx; i < lines.length; i++) {
    const line = lines[i]
    if (HEADER_RE.test(line)) {
      cur = line.replace(/:\s*$/, '').trim()
      sections.set(cur, [])
    } else if (cur) {
      sections.get(cur)!.push(line)
    }
  }

  // gh stores the usage section as "USAGE" (all-caps header); look it up
  // case-insensitively so both "Usage" and "USAGE" resolve.
  const usageHeader = [...sections.keys()].find((k) => k.toLowerCase() === 'usage')
  const usageLine = usageHeader
    ? sections.get(usageHeader)!.find((l) => l.trim().length > 0) ?? ''
    : lines.find((l) => /^usage:\s/i.test(l)) ?? ''

  return { lines, intro, sections, usageHeader, usageLine }
}

// Section headers whose body is a list of subcommands. Cobra uses
// "Available Commands"; kubectl splits the list across "Basic Commands",
// "Deploy Commands", "Other Commands", ...; docker uses "Common Commands",
// "Management Commands", "Swarm Commands". Match any header mentioning
// "command(s)" (covers "Subcommands provided by plugins" too) and exclude
// sections that look command-like but aren't (docker's "Invalid Plugins",
// jq's "Command options").
// oclif (Salesforce CLI, Heroku CLI) splits the list in two: "COMMANDS" holds
// the runnable leaves and "TOPICS" the groups, so both have to be walked. The
// match is on the exact header — gh's "HELP TOPICS" lists prose help articles
// ("gh help exit-codes"), not commands, and must stay out.
export function isCommandsSection(header: string): boolean {
  const h = header.toLowerCase()
  if (h === 'topics') return true
  if (h.includes('invalid plugins')) return false
  if (h.includes('option') || h.includes('flag')) return false
  return h.includes('command')
}

// docker uses "Options" / "Global Options" where cobra uses "Flags" / "Global
// Flags"; accept both so docker subcommands surface their flags. kubectl
// subcommands use "Options" too but with a different per-flag layout, which the
// dialect registry sorts out. psql splits flags across "General options",
// "Input and output options", "Connection options", ... so gather every section
// whose header is flag-shaped, separating global from local. 7zz calls its
// global block "<Switches>".
export function flagBlocks(s: HelpSections): { local: string[]; global: string[] } {
  const local: string[] = []
  const global: string[] = []
  for (const [header, block] of s.sections) {
    const h = header.toLowerCase()
    const isFlagSection =
      h === 'flags' || h === 'options' || h.endsWith(' options') || h.endsWith(' flags') || h.includes('switch')
    if (!isFlagSection) continue
    if (h.includes('global') || h.includes('switch')) global.push(...block)
    else local.push(...block)
  }
  return { local, global }
}

// glab lays its help out as a fixed-width block: every line of the description
// is indented two spaces and right-padded with trailing spaces. `.flag-long`
// renders with `white-space: pre-wrap`, so that padding would show up in the UI
// as a ragged left margin and stray line breaks. Drop the trailing spaces and
// the indent shared by every line — relative indentation inside the block (an
// example, a bullet list) survives, and it's a no-op for unindented help.
export function dedent(text: string): string {
  const lines = text.split('\n').map((l) => l.replace(/[ \t]+$/, ''))
  const indents = lines.filter((l) => l !== '').map((l) => /^[ \t]*/.exec(l)![0].length)
  const common = indents.length > 0 ? Math.min(...indents) : 0
  return lines
    .map((l) => l.slice(common))
    .join('\n')
    .trim()
}

// Does this stream carry the help text itself, as opposed to warnings printed
// alongside it? A help body always announces at least one section — "Usage:",
// "USAGE", "Available Commands:", "FLAGS". Used by the probe to decide which
// stream to hand back.
export function looksLikeHelpBody(text: string): boolean {
  if (text.trim() === '') return false
  return text.split('\n').some((l) => HEADER_RE.test(l) || /^\s*usage\b/i.test(l))
}
