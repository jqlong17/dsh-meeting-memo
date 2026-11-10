/** Same-origin RPC client for the meeting-minutes panel. */
export const RPC_ROUTE = '/dsh-mm/rpc'

export interface RpcError {
  code: string
  message: string
  hint?: string
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

export type RpcCall = <T>(op: string, payload?: Record<string, unknown>) => Promise<RpcResult<T>>

export function createRpc(fetchImpl: typeof fetch | undefined = typeof fetch === 'function' ? fetch : undefined): RpcCall {
  return async <T>(op: string, payload: Record<string, unknown> = {}): Promise<RpcResult<T>> => {
    if (!fetchImpl) return { ok: false, error: { code: 'no-fetch', message: '当前环境没有 fetch()。' } }
    try {
      const response = await fetchImpl(RPC_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, payload }),
      })
      if (!response.ok) {
        return { ok: false, error: { code: `http/${response.status}`, message: `会议纪要服务返回 HTTP ${response.status}。` } }
      }
      const body = await response.json() as unknown
      if (!body || typeof body !== 'object') {
        return { ok: false, error: { code: 'invalid-response', message: '会议纪要服务返回了无效内容。' } }
      }
      return body as RpcResult<T>
    } catch (failure) {
      return { ok: false, error: { code: 'network', message: failure instanceof Error ? failure.message : String(failure) } }
    }
  }
}
