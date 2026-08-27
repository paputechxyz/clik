/**
 * Drives the built app through Playwright's Electron support, for checks that
 * only mean anything against a real window: xterm rendering, PTY round-trips,
 * and what the terminal actually puts into the History panel.
 *
 * Run `electron-vite build` first — this launches `out/`, not the dev server.
 *
 * Every app gets its own throwaway userData directory. The real one holds the
 * user's saved commands and history (`library.json`), and these tests type into
 * a live shell and record history as a side effect, so pointing at it would both
 * corrupt real data and make results depend on whatever was already there.
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')

/**
 * Resolve the Electron binary the same way the `electron` package's own entry
 * point does — `path.txt` names the platform-specific executable inside `dist/`.
 *
 * Both files are written by electron's install step, which pnpm skips when it
 * relinks an already-cached copy of the package. Recovering is
 * `node node_modules/electron/install.js`, hence the pointed error message.
 */
function electronBinary(): string {
  const root = path.join(APP_DIR, 'node_modules/electron')
  const pointer = path.join(root, 'path.txt')
  const relative = fs.existsSync(pointer) ? fs.readFileSync(pointer, 'utf8').trim() : ''
  const binary = relative === '' ? '' : path.join(root, 'dist', relative)
  if (binary === '' || !fs.existsSync(binary)) {
    throw new Error(
      'The Electron binary is missing from node_modules/electron/dist. ' +
        'Run `node node_modules/electron/install.js` to download it.'
    )
  }
  return binary
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface Harness {
  app: ElectronApplication
  page: Page
  /** Titles of the History panel rows, newest first. */
  history: () => Promise<string[]>
  /** Non-blank text of the terminal viewport, for diagnostics on failure. */
  screenText: () => Promise<string>
  focusTerminal: () => Promise<void>
  /** Types text as real key events, so xterm's own key handling runs. */
  type: (text: string, delayMs?: number) => Promise<void>
  press: (key: string) => Promise<void>
  /**
   * Pastes via a real clipboard event. `page.keyboard.insertText` does NOT reach
   * xterm's paste handler, so it would silently exercise nothing.
   */
  paste: (text: string) => Promise<void>
  close: () => Promise<void>
}

export async function launchApp(): Promise<Harness> {
  const mainEntry = path.join(APP_DIR, 'out/main/index.js')
  if (!fs.existsSync(mainEntry)) {
    throw new Error(`${mainEntry} is missing — run \`electron-vite build\` before the e2e suite.`)
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clik-e2e-'))
  const app = await electron.launch({
    executablePath: electronBinary(),
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: APP_DIR,
    timeout: 60_000
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 })

  const screenText = (): Promise<string> =>
    page.evaluate(() => {
      const rows = document.querySelector('.xterm-rows')
      if (!rows) return ''
      return Array.from(rows.children)
        .map((r) => (r.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd())
        .filter((s) => s !== '')
        .join('\n')
    })

  // Wait for the shell to draw its first prompt, then let it settle — typing
  // before the prompt exists would anchor the capture at the wrong column.
  for (let i = 0; i < 80; i++) {
    if ((await screenText()).trim() !== '') break
    await sleep(250)
  }
  await sleep(1200)

  const textarea = page.locator('.xterm-helper-textarea').first()
  const focusTerminal = (): Promise<void> => textarea.focus()
  await focusTerminal()

  return {
    app,
    page,
    screenText,
    focusTerminal,
    history: () =>
      page.evaluate(() => {
        const panel = Array.from(document.querySelectorAll('.lib-panel')).find(
          (el) => el.querySelector('.lib-head-title')?.textContent?.trim() === 'History'
        )
        if (!panel) return []
        // The row's title attribute carries the full preview untruncated.
        return Array.from(panel.querySelectorAll('.lib-list > li')).map(
          (li) => li.getAttribute('title') ?? ''
        )
      }),
    type: async (text, delayMs = 6) => {
      await focusTerminal()
      await page.keyboard.type(text, { delay: delayMs })
    },
    press: async (key) => {
      await focusTerminal()
      await page.keyboard.press(key)
    },
    paste: async (text) => {
      await page.evaluate((payload) => {
        const el = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
        if (!el) throw new Error('terminal textarea not found')
        el.focus()
        const data = new DataTransfer()
        data.setData('text/plain', payload)
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      }, text)
    },
    close: async () => {
      await app.close().catch(() => {})
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  }
}

/**
 * Submits a line and returns the History panel before and after.
 *
 * Assert on the change in the whole list, never on `history[0]` alone:
 * `addTerminalHistory` drops a command that repeats the previous one, so an
 * items[0] check passes even when nothing at all was recorded.
 */
export async function submit(
  h: Harness,
  opts: { type?: string; keys?: string[]; settleMs?: number; typeDelayMs?: number }
): Promise<{ before: string[]; after: string[]; newest: string; added: number }> {
  const before = await h.history()
  if (opts.type !== undefined) {
    await h.type(opts.type, opts.typeDelayMs)
    await sleep(280)
  }
  for (const key of opts.keys ?? []) {
    await h.press(key)
    await sleep(320)
  }
  await h.press('Enter')
  await sleep(opts.settleMs ?? 1100)
  const after = await h.history()
  return { before, after, newest: after[0] ?? '', added: after.length - before.length }
}
