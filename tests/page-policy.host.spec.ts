import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { PageBroker, type PageSession } from '../src/page-broker.ts'
import { registerPagePolicy } from '../src/index.ts'
import type { SitePref } from '../src/site-prefs.ts'

/**
 * The page-edit policy reaches every turn on a session the page is attached to - including the side
 * panel's turns, which the Host does not create - and no other session.
 */
const page = (n = 1, url = 'https://example.test/'): PageSession => ({ version: 2, taskId: 'task-' + n, selectionId: 'sel-' + n, documentId: 'doc-' + n, token: 'page-token-0123456789-' + n, url })
const POLICY = 'You are editing the frontend page bound to this session'

async function rig(prefs: SitePref[] = []) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  const broker = new PageBroker()
  const dispose = registerPagePolicy(ctx.systemPrompt as never, { broker, sitePrefs: () => prefs })
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

  it('adds the site preferences that match the bound page, and only those', async () => {
    const feishu: SitePref = { id: 'f', enabled: true, body: 'FEISHU-RULE: one H1 only', meta: { name: 'Feishu', version: '1.0.0', match: ['*://*.feishu.cn/*'], exclude: [], extra: [] } }
    const off: SitePref = { ...feishu, id: 'g', enabled: false, body: 'DISABLED-RULE' }
    const { promptFor, broker } = await rig([feishu, off])
    broker.bindLease('s1', page(1, 'https://a.feishu.cn/docx/1'))
    broker.bindLease('s2', page(2, 'https://example.test/'))
    const onFeishu = await promptFor('s1'), elsewhere = await promptFor('s2')
    expect(onFeishu).toContain(POLICY)
    expect(onFeishu).toContain('[Feishu v1.0.0]')
    expect(onFeishu).toContain('FEISHU-RULE')
    expect(onFeishu).not.toContain('DISABLED-RULE')
    expect(elsewhere).toContain(POLICY)
    expect(elsewhere).not.toContain('FEISHU-RULE')
    expect(await promptFor('s3')).not.toContain('FEISHU-RULE')
    broker.shutdown()
  })
})
