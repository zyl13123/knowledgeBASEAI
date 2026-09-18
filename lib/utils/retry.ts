// lib/utils/retry.ts
import 'server-only'

export interface RetryOptions {
  retries?: number      // 重试次数（默认 1，即最多调用 2 次）
  timeoutMs?: number    // 单次超时（默认 8000ms）
  backoffMs?: number    // 重试前的等待（默认 500ms，指数递增）
  onRetry?: (err: unknown, attempt: number) => void   // 重试回调（打日志用）
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    retries = 1,
    timeoutMs = 8000,
    backoffMs = 500,
    onRetry,
  } = opts

  let lastErr: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // 用 Promise.race 实现超时
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`调用超时（${timeoutMs}ms）`)),
            timeoutMs
          )
        ),
      ])
    } catch (err) {
      lastErr = err

      // 最后一次失败，直接抛
      if (attempt === retries) break

      // 回调通知（打日志）
      onRetry?.(err, attempt + 1)

      // 退避等待（第 1 次等 500ms，第 2 次等 1000ms...）
      await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)))
    }
  }

  throw lastErr
}