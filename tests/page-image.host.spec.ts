import { describe, expect, it } from 'vitest'
import { registerPageTools, type ImageStore, type PageTool } from '../src/page-tools.ts'
import type { PageBroker } from '../src/page-broker.ts'

/** page_read scope:image: pixels are stored as an attachment and reach the model as an image block. */
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')
const pageOutcome = { ok: true, code: 'READ', modification: 'not-modified', verification: 'dom-observed', retryable: false, scope: 'image',
  image: { mediaType: 'image/jpeg', base64: JPEG_B64, width: 800, height: 600, originalWidth: 1600, originalHeight: 1200, alt: 'a chart' } }

function rig(opts: { store?: ImageStore | undefined; gate?: () => Promise<void>; outcome?: Record<string, unknown> } = {}) {
  const tools = new Map<string, PageTool>()
  const submitted: unknown[] = []
  const saved: { data: Uint8Array; name?: string }[] = []
  const store: ImageStore | undefined = 'store' in opts ? opts.store : {
    imageLimits: { maxImageBytes: 5_000_000, maxMessageImageBytes: 5_000_000 },
    async saveImage(input) { saved.push({ data: input.data, name: input.name }); return { attachmentId: 'sha256:abc', mediaType: 'image/jpeg', bytes: input.data.byteLength, width: 800, height: 600, name: input.name } },
  }
  const broker = { submit: async (_s: unknown, _k: unknown, args: unknown) => { submitted.push(args); return structuredClone(opts.outcome ?? pageOutcome) } } as unknown as PageBroker
  registerPageTools({ register: d => { tools.set(d.name, d); return () => tools.delete(d.name) } }, broker, { store: () => store, gate: opts.gate ?? (async () => {}) })
  const read = (args: unknown) => tools.get('page_read')!.execute(args, { agent: { session: { id: 's' } } }) as Promise<Record<string, unknown>>
  return { read, submitted, saved, tools }
}

describe('page_read scope image', () => {
  it('stores the image and renders it as an image block, without the base64 in the text', async () => {
    const { read, saved, tools, submitted } = rig()
    const out = await read({ scope: 'image', index: 3 })
    expect(submitted).toEqual([expect.objectContaining({ scope: 'image', index: 3 })])
    expect(out.ok).toBe(true)
    expect(saved).toHaveLength(1)
    expect(Array.from(saved[0]!.data)).toEqual([0xff, 0xd8, 0xff, 0xd9])
    expect(saved[0]!.name).toBe('a chart.jpg')
    expect(out.shown).toMatchObject({ width: 800, height: 600, originalWidth: 1600, originalHeight: 1200, label: 'a chart' })
    const blocks = tools.get('page_read')!.output.render({}, out)
    expect(blocks[1]).toEqual({ type: 'image', attachment: expect.objectContaining({ attachmentId: 'sha256:abc' }) })
    expect(JSON.stringify(blocks[0])).not.toContain(JPEG_B64)
  })
  it('refuses, and stores nothing, when the model cannot take images', async () => {
    const { read, saved } = rig({ gate: async () => { throw new Error('model "m" does not declare image input') } })
    expect(await read({ scope: 'image', index: 0 })).toMatchObject({ ok: false, code: 'IMAGE_UNSUPPORTED' })
    expect(saved).toHaveLength(0)
  })
  it('refuses when no attachment store is mounted', async () => {
    const { read } = rig({ store: undefined })
    expect(await read({ scope: 'image', index: 0 })).toMatchObject({ ok: false, code: 'IMAGE_UNSUPPORTED' })
  })
  it('passes page failures through untouched', async () => {
    const { read, saved } = rig({ outcome: { ok: false, code: 'IMAGE_UNREADABLE', message: 'x', commandId: 'c' } })
    expect(await read({ scope: 'image', index: 0 })).toMatchObject({ ok: false, code: 'IMAGE_UNREADABLE' })
    expect(saved).toHaveLength(0)
  })
  it('needs exactly one of index and targetRef, and rejects index elsewhere', async () => {
    const { read, submitted } = rig()
    expect(await read({ scope: 'image' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(await read({ scope: 'image', index: 1, targetRef: 'r' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(await read({ scope: 'document', index: 1 })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(submitted).toHaveLength(0)
  })
  it('accepts a block ref and advertises the scope', async () => {
    const { read, tools, submitted } = rig()
    expect(await read({ scope: 'image', targetRef: 'ref-1' })).toMatchObject({ ok: true })
    expect(submitted).toHaveLength(1)
    expect(JSON.stringify(tools.get('page_read')!.parameters)).toContain('image')
  })
})
