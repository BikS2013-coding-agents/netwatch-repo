import { expect, mock, test } from 'claude-code/testing'

import { digest, endpointOf, isApiCall, parseRequests, redactUrl } from '../hooks/analyze'

type Req = { requestId: string; url: string; method: string; status?: number; resourceType: string; timestamp: number }

const T0 = Date.UTC(2026, 9, 27, 10, 0, 0)
const REQS: Req[] = [
  { requestId: '1', url: 'https://app.test/', method: 'GET', status: 200, resourceType: 'Document', timestamp: T0 },
  { requestId: '2', url: 'https://app.test/static/main.js', method: 'GET', status: 200, resourceType: 'Script', timestamp: T0 + 10 },
  { requestId: '3', url: 'https://app.test/api/orders/123?token=abc&page=2', method: 'POST', status: 500, resourceType: 'Fetch', timestamp: T0 + 20 },
  { requestId: '4', url: 'https://app.test/api/orders/456', method: 'GET', status: 200, resourceType: 'XHR', timestamp: T0 + 30 },
  { requestId: '5', url: 'https://app.test/api/slow', method: 'GET', resourceType: 'Fetch', timestamp: Date.now() + 3600000 },
]

const out = (data: object) => JSON.stringify({ success: true, data, error: null })

test('parses, filters, groups and redacts', async () => {
  const raw = parseRequests(out({ requests: REQS }))
  expect(raw.length).toBe(5)
  expect(raw[4]!.status).toBe(null)
  expect(raw[2]!.type).toBe('Fetch')
  const api = raw.filter(isApiCall)
  expect(api.length).toBe(4) // the script is left out
  expect(endpointOf('GET', 'https://app.test/api/orders/456')).toBe('GET app.test/api/orders/:id')
  expect(redactUrl('https://app.test/x?token=abc&page=2')).toBe('https://app.test/x?token=***&page=2')
  const text = digest(
    api.map((r, i) => ({ ...r, seq: i + 1 })),
    null,
  )
  expect(text).toContain('HTTP errors (>=400): 1')
  expect(text).toContain('POST app.test/api/orders/:id?page&token | 1 | 500×1')
  expect(text).not.toContain('abc')
  expect(() => parseRequests(JSON.stringify({ success: false, error: 'no browser' }))).toThrow('no browser')
})

test('start opens agent-browser, polls once per request and stop keeps pending ones', async ($, on) => {
  const argvs: string[][] = []
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('process.run', (_$, e) => {
    const argv = (e as { argv: string[] }).argv
    argvs.push(argv)
    const isList = argv.includes('requests') && !argv.includes('--clear')
    const stdout = isList ? out({ requests: REQS }) : out({ cleared: true })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })

  const started = await $.command.run({ command: 'netwatch', args: 'start https://app.test/' } as never)
  expect(started.text).toContain('https://app.test/')
  expect(argvs[0]).toEqual(['agent-browser', '--session', 'netwatch', '--headed', 'network', 'requests', '--clear', '--json'])
  expect(argvs[1]).toEqual(['agent-browser', '--session', 'netwatch', '--headed', 'open', 'https://app.test/', '--json'])

  const logged = String((await $.tool.call({ tool: 'mcp__netwatch__api_log' } as never)).result)
  expect(logged).toContain('API/document calls: 3') // the pending /api/slow waits
  expect(logged).toContain('Static assets left out: 1')
  expect(logged).not.toContain('token=abc')

  // agent-browser hands back the same requests every read: nothing is counted twice
  await clock.advance(4000)
  const again = String((await $.tool.call({ tool: 'mcp__netwatch__api_log' } as never)).result)
  expect(again).toContain('API/document calls: 3')

  const stopped = await $.command.run({ command: 'netwatch', args: 'stop' } as never)
  expect(stopped.text).toContain('4 κλήσεις, 1 σφάλματα')
})

test('a missing agent-browser is reported, not thrown', async ($, on) => {
  on('process.run', () => {
    throw new Error('ENOENT')
  })
  const started = await $.command.run({ command: 'netwatch', args: 'start --connect' } as never)
  expect(started.text).toContain('Δεν έγινε σύνδεση με τον Chrome σου')
  expect(started.text).toContain('PATH')
})
