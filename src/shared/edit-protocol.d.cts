type Validation = { ok: true; value: Record<string, unknown> } | { ok: false; code: string; message: string; retryable: false; modification: string; verification: string }
declare const protocol: {
  VERSION: 2
  validateEdit(args: unknown): Validation
  validateRead(args: unknown): Validation
  failure(code: string, message: string, extra?: Record<string, unknown>): Record<string, unknown>
}
export = protocol
