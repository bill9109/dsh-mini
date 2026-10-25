import { describe, expect, it } from 'vitest'
import { registerPageTools, type PageTool } from '../src/page-tools.ts'
import type { PageBroker } from '../src/page-broker.ts'

/** page_edit batches: validated up front, applied in order, stopped at the first failure. */
function rig(outcomes: Record<string, unknown>[]) {
  const tools = new Map<string, PageTool>()
  const submitted: unknown[] = []
  const broker = { submit: async (_s: unknown, _k: unknown, args: unknown) => { submitted.push(args); return outcomes.shift() ?? { ok: true, code: 'EDIT_APPLIED', commandId: 'c' } } } as unknown as PageBroker
  registerPageTools({ register: d => { tools.set(d.name, d); return () => tools.delete(d.name) } }, broker)
  const edit = (args: unknown) => tools.get('page_edit')!.execute(args, { agent: { session: { id: 's' } } }) as Promise<Record<string, unknown>>
  return { edit, submitted, tools }
}
const one = (n: number) => ({ targetRef: 'target-' + n, expectedRevision: 'r' + n, operation: { type: 'replace-block', text: 'x' + n } })

describe('page_edit batches', () => {
  it('applies every edit in order', async () => {
    const { edit, submitted } = rig([])
    const out = await edit({ edits: [one(1), one(2), one(3)] })
    expect(out).toMatchObject({ ok: true, code: 'BATCH_APPLIED', applied: 3 })
    expect(submitted.map(s => (s as { targetRef: string }).targetRef)).toEqual(['target-1', 'target-2', 'target-3'])
  })
  it('stops at the first failure and reports what ran', async () => {
    const { edit, submitted } = rig([{ ok: true, code: 'EDIT_APPLIED', commandId: 'a' }, { ok: false, code: 'REVISION_CONFLICT', commandId: 'b' }])
    const out = await edit({ edits: [one(1), one(2), one(3)] })
    expect(out).toMatchObject({ ok: false, code: 'BATCH_STOPPED', stoppedAt: 1, applied: 1 })
    expect(submitted).toHaveLength(2)
  })
  it('submits nothing when any edit is invalid', async () => {
    const { edit, submitted } = rig([])
    const out = await edit({ edits: [one(1), { expectedRevision: 'r', operation: { type: 'set-format', format: { link: 'javascript:x' } } }] })
    expect(out).toMatchObject({ ok: false, code: 'INVALID_FORMAT', index: 1 })
    expect(submitted).toHaveLength(0)
  })
  it('refuses mixing the single and batch forms, and oversized batches', async () => {
    const { edit, submitted } = rig([])
    expect(await edit({ edits: [one(1)], expectedRevision: 'r' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(await edit({ edits: Array.from({ length: 21 }, (_, i) => one(i)) })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(submitted).toHaveLength(0)
  })
  it('advertises the new operations, content types and scopes', async () => {
    const { tools } = rig([])
    const editSchema = JSON.stringify(tools.get('page_edit')!.parameters), readSchema = JSON.stringify(tools.get('page_read')!.parameters)
    for (const word of ['insert-after', 'delete-block', 'insert-image', 'html', 'link', 'edits']) expect(editSchema).toContain(word)
    expect(readSchema).toContain('document')
  })
})
