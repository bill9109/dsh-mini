import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { PageBroker, type PageSession } from '../src/page-broker.ts'
import { registerPagePolicy } from '../src/index.ts'

/**
 * The page-edit policy reaches every turn on a session the page is attached to - including the side
 * panel's turns, which the Host does not create - and no other session.
 */
const page = (n = 1): PageSession => ({ version: 2, taskId: 'task-' + n, selectionId: 'sel-' + n, documentId: 'doc-' + n, token: 'page-token-0123456789-' + n, url: 'https://example.test/' })
const POLICY = 'You are editing the frontend page bound to this session'

async function rig() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  const broker = new PageBroker()
  const dispose = registerPagePolicy(ctx.systemPrompt as never, broker)
  // Only global sections take part without a scope; context.agent is what the section reads.
  const promptFor = async (sessionId: string) =>
    renderPrompt(await ctx.systemPrompt.assemble({ agent: { id: sessionId, session: { id: sessionId } } } as never))
  return { ctx, broker, dispose, promptFor }
}

describe('page policy prompt section', () => {
  it('is absent for a session no page is attached to', async () => {
    const { promptFor, broker } = await rig()
    expect(await promptFor('s1')).not.toContain(POLICY)
    broker.shutdown()
  })

  it('appears while a side-panel lease holds the page, and leaves with it', async () => {
    const { promptFor, broker } = await rig()
    const p = page()
    broker.bindLease('s1', p)
    expect(await promptFor('s1')).toContain(POLICY)
    expect(await promptFor('s2')).not.toContain(POLICY)
    broker.releaseLease({ taskId: p.taskId, documentId: p.documentId, token: p.token })
    expect(await promptFor('s1')).not.toContain(POLICY)
    broker.shutdown()
  })

  it('appears for a capsule run bound to the session', async () => {
    const { promptFor, broker } = await rig()
    const controller = new AbortController()
    broker.bind('s1', page(), controller.signal)
    expect(await promptFor('s1')).toContain(POLICY)
    controller.abort()
    expect(await promptFor('s1')).not.toContain(POLICY)
    broker.shutdown()
  })

  it('is removed with the plugin effect', async () => {
    const { promptFor, broker, dispose } = await rig()
    broker.bindLease('s1', page())
    dispose()
    expect(await promptFor('s1')).not.toContain(POLICY)
    broker.shutdown()
  })
})
