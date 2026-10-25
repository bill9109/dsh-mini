import { describe, expect, it } from 'vitest'
import { pairingStatus } from '../src/index.ts'

describe('pairing status', () => {
  const now = 10_000_000
  it('is never before any call, connected after a recent accepted call, idle when it goes quiet', () => {
    expect(pairingStatus({}, now)).toEqual({ state: 'never' })
    expect(pairingStatus({ accepted: now - 30_000 }, now)).toEqual({ state: 'connected', lastSeen: now - 30_000 })
    expect(pairingStatus({ accepted: now - 10 * 60_000 }, now)).toEqual({ state: 'idle', lastSeen: now - 10 * 60_000 })
  })
  it('reports a stale code when a wrong code arrived after the last accepted call', () => {
    expect(pairingStatus({ accepted: now - 120_000, refused: now - 5_000 }, now)).toMatchObject({ state: 'stale-code' })
    expect(pairingStatus({ refused: now - 5_000 }, now)).toMatchObject({ state: 'stale-code' })
    expect(pairingStatus({ accepted: now - 1_000, refused: now - 5_000 }, now)).toMatchObject({ state: 'connected' })
    expect(pairingStatus({ refused: now - 10 * 60_000 }, now)).toEqual({ state: 'never' })
  })
})
