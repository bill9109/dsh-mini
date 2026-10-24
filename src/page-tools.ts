import { trace } from './trace.ts'
import { randomUUID } from 'node:crypto'
import protocol from './shared/edit-protocol.cjs'
import { PageBroker, failure, type Json } from './page-broker.ts'

/** Exact used slice of inspected ToolDefinition / ToolRunContext. No identity fallbacks. */
export interface Execution { agent?: { session: { id: string } }; signal?: AbortSignal }
export interface PageTool {
  name: string; description: string; parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): { type: 'text'; text: string }[] }
  execute(args: unknown, exec: Execution): Promise<unknown>
}
export interface ToolRegistry { register(definition: PageTool): () => void }
const output = {
  schema: { type: 'object', properties: { ok: { type: 'boolean' }, code: { type: 'string' }, commandId: { type: 'string' } }, required: ['ok', 'code', 'commandId'], additionalProperties: true },
  render: (_args: unknown, value: unknown): { type: 'text'; text: string }[] => [{ type: 'text', text: JSON.stringify(value) }],
}
const targetRef = { type: 'string', description: 'Exact opaque ref from this task snapshot or page_read. Never invent one. Omit only to use the task-bound initial target.' }
const expectedRevision = { type: 'string', description: 'Revision returned with this exact target; prevents stale writes.' }
const execute = (broker: PageBroker, kind: 'read' | 'edit') => async (args: unknown, exec: Execution): Promise<unknown> => {
  trace('tool/' + kind + '/enter', { args: args && typeof args === 'object' ? Object.keys(args as object).join(',') : String(args) })
  const checked = kind === 'read' ? protocol.validateRead(args) : protocol.validateEdit(args)
  if (!checked.ok) return { ...checked, commandId: randomUUID() }
  try {
    const out = await broker.submit(exec.agent?.session?.id, kind, checked.value as Record<string, Json>, exec.signal) as Record<string, unknown>
    trace('tool/' + kind + '/exit', { ok: out?.ok === true, code: out?.code ?? null, commandId: out?.commandId ?? null, state: out?.state ?? null }, out?.ok === false ? 'error' : 'info')
    return out
  }
  catch { return failure('INVALID_COMMAND', 'Page command must be bounded lossless JSON.', { commandId: randomUUID() }) }
}
export function registerPageTools(tools: ToolRegistry, broker: PageBroker): () => void {
  if (protocol.VERSION !== 2) throw new Error('Page tools require shared protocol version 2')
  const disposers: (() => void)[] = []
  try {
    disposers.push(tools.register({
      name: 'page_read', description: 'Read the page. scope:target (default) reads the bound target; scope:outline returns ONLY the document top level - a cheap map used to decide what to read next, and the fastest way to reach a place described in words such as "below the table"; scope:range returns the blocks between at and to; scope:keyword searches the document. Read as widely as you need: reading has no side effects, and every returned block carries a ref this page issued, which is the only thing you may write through. Results are bounded and paged by cursor.',
      parameters: { type: 'object', properties: {
        targetRef,
        reason: { type: 'string' },
        at: { type: 'string', description: 'Read anchor: the target for scope:target, the range start for scope:range. Must be a ref this page issued.' },
        to: { type: 'string', description: 'Range end (scope:range only); omit to read through to the end of the document.' },
        scope: { type: 'string', enum: ['target', 'outline', 'range', 'keyword'],
          description: 'target (default) reads the bound target. outline returns top-level blocks only - a map, not content; use it first when you do not yet know where to work. range returns the span from at to to. keyword searches the document. Items carry depth and parentId so nesting is explicit, including blocks the DOM has not mounted.' },
        find: { type: 'string', description: 'Search text for scope:keyword, or within the chosen scope.' },
        findText: { type: 'string', description: 'Search inside the bound target (legacy alias for find with the default scope).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 32, description: 'Maximum items to return.' },
        cursor: { type: 'string', description: 'Opaque cursor returned by a previous read; pass it back to continue.' },
      }, additionalProperties: false }, output, execute: execute(broker, 'read'),
    }))
    disposers.push(tools.register({
      name: 'page_edit', description: 'Edit only the authenticated task-bound frontend page. Use exact targetRef/revision and supported capabilities. A timeout after start is unknown; query status, never repeat blindly. Final replies never write.',
      parameters: { type: 'object', properties: { targetRef, expectedRevision, operation: {
        type: 'object', properties: {
          type: { type: 'string', enum: ['replace-selection', 'insert-at-caret', 'replace-block', 'keep-block-kind', 'set-format'] },
          text: { type: 'string', description: 'Required except for set-format, where text is forbidden. With contentType markdown on a whole block this is the new SHAPE. One call may mix types (#/##/### headings, 1. ordered list, - bullet, **bold**) - do not split it into several calls. Write ordinals as list syntax "1.", never as a bold number inside the item, or they render as bullets that merely contain digits. A heading may also carry the editors own auto-numbering (the "1. " the page renders, which markdown cannot express): create the heading first, then set-format { autoNumber: true } on that heading block - that takes a second call. Structures outside this subset (callout, grid, table, mermaid, checkboxes) are refused, not silently degraded. ALWAYS check the returned missing/PARTIAL_STRUCTURE: it names the lines that did not materialise.' },
          contentType: { type: 'string', enum: ['plain', 'markdown'], default: 'plain', description: 'Plain writes literally (one block, unchanged type). Markdown is rendered: a whole-block replace-block may become several heading/list blocks, reported back line by line. Request it explicitly; page_read reports which types the adapter accepts.' },
          format: { type: 'object', properties: { bold: { type: 'boolean' }, italic: { type: 'boolean' }, underline: { type: 'boolean' }, strikethrough: { type: 'boolean' }, color: { oneOf: [{ type: 'string' }, { type: 'null' }] }, highlight: { oneOf: [{ type: 'string' }, { type: 'null' }] }, autoNumber: { type: 'boolean' } }, additionalProperties: false },
        }, required: ['type'], additionalProperties: false,
      } }, required: ['expectedRevision', 'operation'], additionalProperties: false }, output, execute: execute(broker, 'edit'),
    }))
    disposers.push(tools.register({
      name: 'page_operation_status', description: 'Session-authorized status for a previous commandId, including the full actual nested outcome. Available after the page task turn ends; never implies an edit succeeded.',
      parameters: { type: 'object', properties: { commandId: { type: 'string' } }, required: ['commandId'], additionalProperties: false }, output,
      async execute(args, exec) {
        const commandId = (args as { commandId?: unknown } | null)?.commandId
        if (typeof commandId !== 'string' || !commandId || commandId.length > 128) return failure('INVALID_COMMAND_ID', 'A commandId is required.', { commandId: randomUUID() })
        return broker.status(exec.agent?.session?.id, commandId)
      },
    }))
  } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
  return () => { for (const dispose of disposers.splice(0).reverse()) dispose() }
}
