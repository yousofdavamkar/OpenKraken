import { createHash } from 'node:crypto';
import { ProviderError } from './provider-error.js';
import type { ProviderPollingPolicy as PollingPolicy } from '@openkraken/ipc-contract';

type State = PollingPolicy & { failures: number; failedEndpoint?: string };

export class ProviderPollingPolicy {
  private policies = new Map<string, State>();
  private overflowDeadline = 0;
  private overflowInterval = 0;

  private key(origin: string, token: string) {
    return createHash('sha256')
      .update(JSON.stringify([origin, token]))
      .digest('hex');
  }

  retryAt(origin: string, token: string) {
    return this.get(origin, token).blockedUntil ?? undefined;
  }

  get(origin: string, token: string): PollingPolicy {
    const policy = this.policies.get(this.key(origin, token));
    const deadline = Math.max(this.overflowDeadline, policy?.blockedUntil ?? 0);
    return {
      minimumIntervalMs: Math.max(this.overflowInterval, policy?.minimumIntervalMs ?? 0),
      blockedUntil: deadline > Date.now() ? deadline : null,
    };
  }

  assertAllowed(origin: string, token: string) {
    const retryAt = this.retryAt(origin, token);
    if (retryAt !== undefined)
      throw new ProviderError(
        'PROVIDER_RATE_LIMIT',
        `The provider requested a pause. Try again after ${new Date(retryAt).toISOString()}.`,
        retryAt,
      );
  }

  observe(origin: string, token: string, url: string, status: number, headers: Headers) {
    const key = this.key(origin, token);
    const previous = this.policies.get(key);
    const current: State = {
      ...this.get(origin, token),
      failures: previous?.failures ?? 0,
      failedEndpoint: previous?.failedEndpoint,
    };
    const endpoint = createHash('sha256').update(url).digest('hex');
    const interval = headers.get('x-poll-interval');
    if (interval !== null && /^\d+$/.test(interval))
      current.minimumIntervalMs = Math.max(
        current.minimumIntervalMs,
        Math.min(8640000000000000, Number(interval) * 1000),
      );
    const value = headers.get('retry-after');
    const now = Date.now();
    let retryAt =
      value === null
        ? 0
        : /^\d+$/.test(value)
          ? Math.min(8640000000000000, now + Number(value) * 1000)
          : Date.parse(value);
    if (!Number.isFinite(retryAt)) retryAt = 0;
    const reset = headers.get('x-ratelimit-reset');
    if (headers.get('x-ratelimit-remaining') === '0' && reset !== null && /^\d+$/.test(reset))
      retryAt = Math.max(retryAt, Math.min(8640000000000000, Number(reset) * 1000));
    const rateLimited = status === 429 || headers.get('x-ratelimit-remaining') === '0';
    if (rateLimited) {
      current.failures = Math.min(7, current.failures + 1);
      current.failedEndpoint = endpoint;
      if (retryAt <= now) retryAt = now + Math.min(3600000, 60000 * 2 ** (current.failures - 1));
    } else if (
      ((status >= 200 && status < 300) || status === 304) &&
      current.failedEndpoint === endpoint
    ) {
      current.failures = 0;
      current.failedEndpoint = undefined;
    }
    if (retryAt > now) current.blockedUntil = Math.max(current.blockedUntil ?? 0, retryAt);
    if (current.blockedUntil !== null || current.minimumIntervalMs > 0 || current.failures) {
      if (!this.policies.has(key) && this.policies.size >= 256) {
        const oldest = this.policies.entries().next().value!;
        // Bound metadata without forgetting a server constraint under credential churn.
        this.overflowDeadline = Math.max(this.overflowDeadline, oldest[1].blockedUntil ?? 0);
        this.overflowInterval = Math.max(this.overflowInterval, oldest[1].minimumIntervalMs);
        this.policies.delete(oldest[0]);
      }
      this.policies.set(key, current);
    } else this.policies.delete(key);
  }

  observeForbiddenBody(origin: string, token: string, url: string, body: Buffer) {
    // Headers were already observed. Do not count the same response twice.
    if (this.retryAt(origin, token) !== undefined) return;
    try {
      const value: unknown = JSON.parse(body.toString('utf8'));
      if (
        typeof value === 'object' &&
        value !== null &&
        'message' in value &&
        typeof value.message === 'string' &&
        /rate limit|abuse detection/i.test(value.message)
      )
        this.observe(origin, token, url, 429, new Headers());
    } catch {
      // Invalid error payloads are never treated as scheduling instructions.
    }
  }
}
