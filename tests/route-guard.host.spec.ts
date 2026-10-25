import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { guarded } from '../src/index.ts'

/** GUI routes run DSH's own connection admission; without it they refuse instead of serving. */
function call(gate: Parameters<typeof guarded>[0]) {
  let ran = false, status = 0
  const response = { writeHead(code: number) { status = code; return this }, end() {} } as unknown as ServerResponse
  void guarded(gate, () => { ran = true; status = 200 })({ headers: {} } as IncomingMessage, response)
  return { ran, status }
}

describe('guarded GUI routes', () => {
  it('serves an admitted request', () => {
    expect(call(() => ({ requestRejection: () => undefined }))).toEqual({ ran: true, status: 200 })
  })
  it('refuses with the admission status, without running the handler', () => {
    expect(call(() => ({ requestRejection: () => 401 }))).toEqual({ ran: false, status: 401 })
    expect(call(() => ({ requestRejection: () => 403 }))).toEqual({ ran: false, status: 403 })
  })
  it('fails closed when the connection service is absent', () => {
    expect(call(() => undefined)).toEqual({ ran: false, status: 403 })
  })
})
