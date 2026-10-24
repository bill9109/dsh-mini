/**
 * Minimal declarations for the slice of `ws` (8.x) this package uses. The consumer tree ships
 * ws itself but not @types/ws, so this keeps the type check self-contained.
 */
declare module 'ws' {
  import type { IncomingMessage } from 'node:http'
  import type { Duplex } from 'node:stream'
  export type RawData = Buffer | ArrayBuffer | Buffer[]
  export class WebSocket {
    /** Client side (used by tests). */
    constructor(url: string, options?: { headers?: Record<string, string> })
    readonly readyState: number
    send(data: string): void
    close(code?: number, reason?: string): void
    terminate(): void
    on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: 'open', listener: () => void): this
  }
  export class WebSocketServer {
    constructor(options: { noServer: true; maxPayload?: number })
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: WebSocket) => void): void
    close(): void
  }
  export default WebSocket
}
