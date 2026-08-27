/**
 * What the terminal records into the History panel.
 *
 * This is capture-by-reading-the-screen (see TerminalView's submitLine), and it
 * is only testable against a real shell: recall, tab completion and line wrapping
 * are all things the shell draws, not things the keystroke stream describes.
 * Each `it` below pins a bug that shipped.
 *
 * One app instance is shared and the cases run in order, so a stray shell state
 * from one case is visible to the next — which is deliberate, that is how the
 * real thing is used.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, sleep, submit, type Harness } from './harness'

let h: Harness

beforeAll(async () => {
  h = await launchApp()
}, 120_000)

afterAll(async () => {
  await h?.close()
})

// Long enough to spill over a row break at any sane terminal width, which is
// what used to truncate the recorded command.
const LONG =
  'echo "SELECT Id, ScratchOrg, SignupUsername, Status, ExpirationDate, CreatedDate, SignupInstance FROM ScratchOrgInfo ORDER BY CreatedDate DESC padding padding padding to force a wrap"'

describe('typing a command', () => {
  it('records it', async () => {
    const { newest, added } = await submit(h, { type: 'echo hello' })
    expect(newest).toBe('echo hello')
    expect(added).toBe(1)
  })

  it('records a command long enough to wrap, in full', async () => {
    const { newest, added } = await submit(h, { type: LONG, typeDelayMs: 3 })
    expect(newest).toBe(LONG)
    expect(added).toBe(1)
  })

  it('records a command containing wide/CJK characters verbatim', async () => {
    const cmd = 'echo CJK-日本語テキストのテスト-and-ascii'
    const { newest, added } = await submit(h, { type: cmd })
    expect(newest).toBe(cmd)
    expect(added).toBe(1)
  })

  it('records the edited line when the cursor moved mid-line', async () => {
    const before = await h.history()
    await h.type('world"')
    await h.press('Home')
    await h.type('echo "hello ')
    await sleep(300)
    await h.press('Enter')
    await sleep(1100)
    const after = await h.history()
    expect(after[0]).toBe('echo "hello world"')
    expect(after.length - before.length).toBe(1)
  })

  it('records nothing for Enter on an empty line', async () => {
    const before = await h.history()
    await h.press('Enter')
    await sleep(900)
    expect(await h.history()).toHaveLength(before.length)
  })
})

describe('history recall', () => {
  // Recall redraws the line from the shell with no keystrokes to mirror, which
  // is what the old keystroke-searching capture could not see.
  it('records the recalled command on a bare Up', async () => {
    const { newest } = await submit(h, { keys: ['ArrowUp'] })
    // Up recalls the immediately previous command, so this necessarily repeats
    // the newest entry and is deduped — the point is that it is not empty and
    // not garbled.
    expect(newest).not.toBe('')
    expect(newest).toBe((await h.history())[0])
  })

  it('records the whole recalled command, not just the typed prefix', async () => {
    // The reported bug: typing `sf`, recalling `sf data query ...`, then Enter
    // filed away a bare `sf`.
    await submit(h, { type: 'echo recall-target-alpha' })
    const { newest, added } = await submit(h, { type: 'echo recall', keys: ['ArrowUp'] })
    expect(newest).not.toBe('echo recall')
    expect(newest).toBe('echo recall-target-alpha')
    expect(added).toBe(0) // dedupes against the seed above
  })

  it('records the right entry when recalling further back', async () => {
    await submit(h, { type: 'echo seed-alpha' })
    await submit(h, { type: 'echo seed-beta' })
    const { newest, added } = await submit(h, { keys: ['ArrowUp', 'ArrowUp'] })
    expect(newest).toBe('echo seed-alpha')
    expect(added).toBe(1) // differs from the previous newest, so genuinely added
  })

  it('records the completed command after tab completion', async () => {
    const { newest } = await submit(h, { type: 'ech', keys: ['Tab'] })
    expect(newest.startsWith('ech')).toBe(true)
  })
})

describe('input that is never echoed', () => {
  it('is not recorded, and does not record the prompt drawn over it', async () => {
    // `read -s` takes input without echoing. Recording the keystroke mirror here
    // would write the secret to history; re-reading the row a moment later would
    // instead pick up the next prompt and file that away as a command.
    await submit(h, { type: 'read -s SECRETVAR', settleMs: 1300 })
    const before = await h.history()

    await h.type('hunter2-topsecret', 10)
    await sleep(350)
    await h.press('Enter')
    await sleep(1500)

    const after = await h.history()
    expect(after.join('\n')).not.toContain('hunter2')
    expect(after).toHaveLength(before.length)
  })
})

describe('paste', () => {
  it('records a paste submitted by a separate Enter', async () => {
    const cmd = 'echo "paste-marker-alpha with several words"'
    await h.paste(cmd)
    await sleep(700)
    expect(await h.screenText()).toContain('paste-marker-alpha')
    await h.press('Enter')
    await sleep(1400)
    expect((await h.history())[0]).toBe(cmd)
  })

  it('records a paste whose trailing newline submits it', async () => {
    // Arrives as one chunk, so the echo cannot have reached the buffer yet and
    // the keystroke mirror is the only source.
    const cmd = 'echo "paste-marker-beta trailing newline"'
    await h.paste(cmd + '\n')
    await sleep(1600)
    expect((await h.history())[0]).toBe(cmd)
  })
})

describe('interrupted and cleared lines', () => {
  it('records nothing for a line abandoned with Ctrl+C, and captures the next one', async () => {
    const before = await h.history()
    await h.type('this-will-be-abandoned')
    await sleep(250)
    await h.press('Control+c')
    await sleep(700)
    expect(await h.history()).toHaveLength(before.length)

    const { newest, added } = await submit(h, { type: 'echo after-ctrl-c' })
    expect(newest).toBe('echo after-ctrl-c')
    expect(added).toBe(1)
  })

  it('records `clear` itself even though it wipes the buffer', async () => {
    const { newest, added } = await submit(h, { type: 'clear', settleMs: 1400 })
    expect(newest).toBe('clear')
    expect(added).toBe(1)
  })

  it('captures the command after a clear', async () => {
    const { newest, added } = await submit(h, { type: 'echo after-clear' })
    expect(newest).toBe('echo after-clear')
    expect(added).toBe(1)
  })
})

describe('timing', () => {
  it('captures a command typed with no delay and submitted immediately', async () => {
    // The trailing characters' echo is still in flight when Enter is pressed.
    for (const cmd of ['echo fast-one', 'echo fast-two-typed-at-full-speed-with-a-longer-line']) {
      await h.focusTerminal()
      await h.page.keyboard.type(cmd, { delay: 0 })
      await h.page.keyboard.press('Enter')
      await sleep(1200)
      expect((await h.history())[0]).toBe(cmd)
    }
  })

  it('captures a recall submitted with no pause after the arrow key', async () => {
    await submit(h, { type: 'echo rapid-target' })
    await h.focusTerminal()
    await h.page.keyboard.type('echo rapid', { delay: 0 })
    await h.page.keyboard.press('ArrowUp')
    await h.page.keyboard.press('Enter')
    await sleep(1400)
    const newest = (await h.history())[0]
    expect(newest).not.toBe('echo rapid')
    expect(newest).toBe('echo rapid-target')
  })
})

describe('commands ending near a row boundary', () => {
  // A command that fills its last row exactly is where an over-eager read can
  // run on into the row below and weld program output onto the entry.
  it('records exactly, across lengths spanning the wrap point', async () => {
    const mismatches: Array<{ length: number; sent: string; got: string }> = []
    for (let total = 132; total <= 146; total++) {
      const prefix = `echo L${total}-`
      const cmd = prefix + 'x'.repeat(total - prefix.length)
      await h.type(cmd, 2)
      await sleep(320)
      await h.press('Enter')
      await sleep(850)
      const got = (await h.history())[0] ?? ''
      if (got !== cmd) mismatches.push({ length: total, sent: cmd, got })
    }
    expect(mismatches).toEqual([])
  }, 60_000)
})
