import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ApiCall, Watch } from '../types'
import { clock, counts, digest, isApiCall, parseRequests, summaryLine } from './analyze'
import type { RawRequest } from './analyze'

const PANE = 'netwatch'
const POLL_MS = 4000
const MAX_CALLS = 3000
const REPORT_MODEL = 'sonnet'

// The browser is driven through the agent-browser CLI (Chrome DevTools Protocol),
// so the mod works in any session, whatever the model provider: Claude in Chrome
// is only there with a claude.ai login.
const AB = 'agent-browser'
const AB_SESSION = 'netwatch'
// A request with no response yet is recorded once it is this old (failed or hanging).
const PENDING_MS = 30000
// agent-browser keeps every request of the session; empty it past this size.
const BUFFER_MAX = 1500

const LOG_TOOL = 'mcp__netwatch__api_log'

const CALLS = { plugin: 'netwatch', key: 'calls' } as const
const WATCH = { plugin: 'netwatch', key: 'watch' } as const
const calls = atom(CALLS, [] as ApiCall[])
const watch = atom(WATCH, null as Watch | null)

const HELP = [
  'netwatch — παρακολούθηση API calls web app στον Chrome (μέσω agent-browser)',
  '  /netwatch start [url]            ανοίγει δικό του ορατό Chrome και ξεκινά την καταγραφή',
  '  /netwatch start --connect [url]  καταγράφει στον δικό σου Chrome (θέλει remote debugging)',
  '  /netwatch stop                   σταματά (τα δεδομένα μένουν)',
  '  /netwatch report [ερώτηση]       ανάλυση του τι έγινε στο session',
  '  /netwatch status                 σύνοψη και άνοιγμα του pane',
  '  /netwatch clear                  σβήνει τις κλήσεις που συλλέχθηκαν',
].join('\n')

const SYSTEM = `Είσαι αναλυτής δικτυακής κίνησης web εφαρμογών. Λαμβάνεις τις HTTP κλήσεις (API, fetch/XHR, έγγραφα) που έκανε μια web εφαρμογή στον Chrome κατά τη διάρκεια ενός session, όπως τις κατέγραψε το agent-browser μέσω του Chrome DevTools Protocol: method, URL, status code, τύπος πόρου (Document, XHR, Fetch κ.λπ.) και η ώρα αποστολής — χωρίς headers, bodies ή χρόνους απόκρισης.

Γράψε στα ελληνικά, σε Markdown, με τις ενότητες:
1. **Σύνοψη** — 2-3 προτάσεις για το τι έκανε ο χρήστης / η εφαρμογή.
2. **Χρονολόγιο ενεργειών** — συμπέρανε τα βήματα του χρήστη (login, αναζήτηση, άνοιγμα εγγραφής, υποβολή φόρμας κ.λπ.) από την αλληλουχία των κλήσεων· σημείωσε πότε κάτι είναι εικασία.
3. **Endpoints** — πίνακας με τα κύρια endpoints, τι φαίνεται να κάνουν, πόσες φορές κλήθηκαν.
4. **Σφάλματα & ανωμαλίες** — 4xx/5xx, επαναλαμβανόμενες/διπλές κλήσεις, polling, N+1 μοτίβα, κλήσεις χωρίς status.
5. **Παρατηρήσεις ασφάλειας** — π.χ. ευαίσθητα δεδομένα σε query strings, http αντί https, κλήσεις σε τρίτους.
6. **Τι δεν φαίνεται** — μία γραμμή για τους περιορισμούς των δεδομένων.
Μη φτιάχνεις στοιχεία που δεν υπάρχουν στα δεδομένα.`

type Engine = EngineInterface

let timer: Timer | undefined
let isPolling = false
// Request ids already recorded; rebuilt from the state after a reload.
let seen: Set<string> | undefined

/** Runs agent-browser on the netwatch session; `ok: false` with the reason on any failure. */
async function ab($: Engine, mode: Watch['mode'], args: string[], timeoutMs = 30000) {
  const launch = mode === 'connect' ? ['--auto-connect'] : ['--headed']
  try {
    const r = await $.process.run([AB, '--session', AB_SESSION, ...launch, ...args, '--json'], { timeoutMs })
    if (r.exitCode !== 0) {
      let msg = r.stderr.trim() || r.stdout.trim()
      try {
        msg = String((JSON.parse(r.stdout) as { error?: unknown }).error ?? msg)
      } catch {}
      return { ok: false as const, text: msg.slice(0, 400) || `exit code ${r.exitCode}` }
    }
    return { ok: true as const, text: r.stdout }
  } catch (err) {
    return { ok: false as const, text: `δεν ξεκίνησε το ${AB} (${String(err).slice(0, 200)}). Είναι εγκατεστημένο και στο PATH;` }
  }
}

async function getCalls($: Engine): Promise<ApiCall[]> {
  return (await $.state.get(CALLS)).value ?? []
}

async function getWatch($: Engine): Promise<Watch | null> {
  return (await $.state.get(WATCH)).value ?? null
}

async function refreshStatus($: Engine) {
  const w = await getWatch($)
  $.ui.status(w ? summaryLine(await getCalls($), w) : undefined)
}

async function setError($: Engine, w: Watch, text: string) {
  if (w.lastError === text) return
  await update($, watch, x => (x ? { ...x, lastError: text.slice(0, 300) } : x))
  $.ui.toast(`netwatch: ${text.slice(0, 120)}`)
}

/** Reads the browser's requests and records the new ones; `final` also records those still pending. */
async function poll($: Engine, final = false) {
  if (isPolling) return
  isPolling = true
  try {
    const w = await getWatch($)
    if (!w?.isActive) return
    const got = await ab($, w.mode, ['network', 'requests'])
    if (!got.ok) return await setError($, w, got.text)
    let raw: RawRequest[]
    try {
      raw = parseRequests(got.text)
    } catch (err) {
      return await setError($, w, String(err))
    }

    seen ??= new Set((await getCalls($)).map(c => c.requestId))
    const now = Date.now()
    const ready = raw.filter(r => !seen!.has(r.requestId) && (final || r.status !== null || now - r.at > PENDING_MS))
    for (const r of ready) seen.add(r.requestId)
    const kept = ready.filter(isApiCall)
    if (kept.length) {
      await update($, calls, list => {
        const prev = list ?? []
        let seq = prev.at(-1)?.seq ?? 0
        return [...prev, ...kept.map(r => ({ ...r, seq: ++seq }))].slice(-MAX_CALLS)
      })
    }
    if (ready.length !== kept.length || w.lastError !== null) {
      await update($, watch, x => (x ? { ...x, ignored: x.ignored + ready.length - kept.length, lastError: null } : x))
    }
    // Requests sent between the read and the clear are lost; past this size that is the lesser evil.
    if (raw.length > BUFFER_MAX) {
      await ab($, w.mode, ['network', 'requests', '--clear'])
      seen.clear()
    }
    await refreshStatus($)
  } finally {
    isPolling = false
  }
}

function startTimer($: Engine) {
  timer?.cancel()
  timer = $.clock.every(POLL_MS, () => void poll($))
}

async function start($: Engine, args: string[]): Promise<string> {
  const mode: Watch['mode'] = args.includes('--connect') ? 'connect' : 'browser'
  const url = args.find(a => a !== '--connect') ?? null

  // Launch (or attach to) the browser and drop the requests already there.
  const ready = await ab($, mode, ['network', 'requests', '--clear'], 60000)
  if (!ready.ok) {
    return mode === 'connect'
      ? `Δεν έγινε σύνδεση με τον Chrome σου: ${ready.text}\n` +
          'Άνοιξε στον Chrome το chrome://inspect/#remote-debugging, ενεργοποίησε το remote debugging και ξαναδοκίμασε.'
      : `Δεν άνοιξε ο Chrome του agent-browser: ${ready.text}`
  }
  if (url) {
    const nav = await ab($, mode, ['open', url], 60000)
    if (!nav.ok) return `Η πλοήγηση στο ${url} απέτυχε: ${nav.text}`
  } else if (mode === 'browser') {
    await ab($, mode, ['open', 'about:blank'], 60000)
  }

  seen = new Set()
  await update($, calls, () => [])
  await update($, watch, () => ({
    mode,
    url,
    isActive: true,
    startedAt: Date.now(),
    stoppedAt: null,
    ignored: 0,
    lastError: null,
  }))
  startTimer($)
  void $.ui.open({ id: PANE, title: 'API calls' })
  await refreshStatus($)
  const where = mode === 'connect' ? 'στον δικό σου Chrome (στην καρτέλα που πήρε το agent-browser)' : 'στο παράθυρο Chrome που άνοιξε το agent-browser'
  return [
    `Ξεκίνησε η παρακολούθηση ${where}${url ? ` — ${url}` : ''}.`,
    url ? 'Χρησιμοποίησε την εφαρμογή εκεί.' : 'Άνοιξε την εφαρμογή εκεί — η καταγραφή ξεκινά από τώρα.',
    'Μετά: /netwatch report',
  ].join('\n')
}

async function stop($: Engine): Promise<string> {
  timer?.cancel()
  timer = undefined
  const w = await getWatch($)
  if (!w?.isActive) return 'Δεν τρέχει παρακολούθηση.'
  await poll($, true) // collect the last requests, pending ones included
  await update($, watch, x => (x ? { ...x, isActive: false, stoppedAt: Date.now() } : x))
  await refreshStatus($)
  const { total, errors } = counts(await getCalls($))
  return `Σταμάτησε η παρακολούθηση: ${total} κλήσεις, ${errors} σφάλματα. /netwatch report για ανάλυση.`
}

async function report($: Engine, question: string): Promise<string> {
  const w = await getWatch($)
  if (w?.isActive) await poll($)
  const list = await getCalls($)
  if (!list.length) return 'Δεν έχουν καταγραφεί κλήσεις ακόμη. Ξεκίνα με /netwatch start.'
  const data = digest(list, await getWatch($))
  const prompt = `${question ? `Ερώτηση του χρήστη: ${question}\n\n` : ''}Δεδομένα session:\n\n${data}`
  const r = await $.model.complete({ model: REPORT_MODEL, system: SYSTEM, prompt, maxTokens: 6000, timeoutMs: 240000 })
  if (!r.isAnswered) return `Η ανάλυση απέτυχε (${r.reason}). Τα ακατέργαστα δεδομένα:\n\n${data}`

  const home = await $.env.get('HOME')
  let saved = ''
  if (home) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const base = `${home}/.claude/netwatch/${stamp}`
    await $.fs.write(`${base}.md`, `${r.text}\n\n---\n\n## Δεδομένα\n\n\`\`\`\n${data}\n\`\`\`\n`)
    await $.fs.write(`${base}.json`, JSON.stringify({ watch: await getWatch($), calls: list }, null, 2))
    saved = `\n\n_Αποθηκεύτηκε: ${base}.md (και .json)_`
  }
  return r.text + saved
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'netwatch',
      description: 'Παρακολούθηση και ανάλυση των API calls μιας web app στον Chrome',
      argumentHint: 'start [--connect] [url] | stop | report [ερώτηση] | status | clear',
    })
    await $.tool.register({
      name: 'api_log',
      description:
        'Returns the HTTP/API calls the netwatch mod captured from the web app open in Chrome during this session: ' +
        'an endpoint table (count, statuses) and a chronological timeline (method, status, type, URL). ' +
        'Use it when the user asks what the web app did, which APIs it called, or about failed requests.',
      inputSchema: { type: 'object', properties: {} },
    })
    // A reload (or restart) drops timers: resume a watch that was running.
    if ((await getWatch($))?.isActive) startTimer($)
    await refreshStatus($)
    return started
  })

  on('command.run', { command: 'netwatch' }, async ($, e) => {
    const [sub = 'status', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    switch (sub) {
      case 'start':
        return { text: await start($, rest) }
      case 'stop':
        return { text: await stop($) }
      case 'report':
        return { text: await report($, rest.join(' ')) }
      case 'clear':
        await update($, calls, () => [])
        await refreshStatus($)
        return { text: 'Οι κλήσεις σβήστηκαν.' }
      case 'status': {
        const w = await getWatch($)
        void $.ui.open({ id: PANE, title: 'API calls' })
        if (!w) return { text: HELP }
        const err = w.lastError ? `\nΤελευταίο σφάλμα: ${w.lastError}` : ''
        const where = w.mode === 'connect' ? 'ο Chrome σου' : 'Chrome του agent-browser'
        return { text: `${summaryLine(await getCalls($), w)} · ${where}${err}` }
      }
      default:
        return { text: HELP }
    }
  })

  on('tool.call', { tool: LOG_TOOL }, async $ => {
    const w = await getWatch($)
    if (w?.isActive) await poll($)
    const list = await getCalls($)
    return { result: list.length ? digest(list, await getWatch($)) : 'netwatch has captured no calls. The user starts it with /netwatch start.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, calls)
    const w = await read($, watch)
    const width = Math.max(30, e.props.bodyColumns ?? 60)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 5)
    const colorOf = (s: number | null) => (s === null ? undefined : s >= 500 ? 'red' : s >= 400 ? 'yellow' : 'green')

    return (
      <Box flexDirection="column">
        <Text bold>{summaryLine(list ?? [], w ?? null)}</Text>
        {w?.lastError && <Text color="red" wrap="truncate-end">{w.lastError}</Text>}
        {!list?.length && <Text dimColor>{w ? 'Καμία κλήση ακόμη.' : 'Ξεκίνα με /netwatch start [url]'}</Text>}
        {(list ?? []).slice(-room).map(c => {
          let path = c.url
          try {
            const u = new URL(c.url)
            path = u.pathname + u.search
          } catch {}
          return (
            <Text wrap="truncate-end">
              <Text dimColor>{clock(c.at)} </Text>
              <Text bold>{c.method.padEnd(6)}</Text>
              <Text color={colorOf(c.status)} dimColor={c.status === null}>{String(c.status ?? '---')} </Text>
              <Text>{path.slice(0, width)}</Text>
            </Text>
          )
        })}
      </Box>
    )
  })
}
