/**
 * In-process low-cardinality metrics for ops/health.
 * Not a replacement for Prometheus; safe for single-node PM2.
 */

export interface HttpMetricSample {
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
}

const state = {
  requestCount: 0,
  errorCount4xx: 0,
  errorCount5xx: 0,
  totalDurationMs: 0,
  externalFailures: 0,
  startedAt: Date.now(),
};

export function recordHttpMetric(sample: HttpMetricSample): void {
  state.requestCount += 1;
  state.totalDurationMs += sample.durationMs;
  if (sample.statusCode >= 500) {
    state.errorCount5xx += 1;
  } else if (sample.statusCode >= 400) {
    state.errorCount4xx += 1;
  }
}

export function recordExternalFailure(): void {
  state.externalFailures += 1;
}

export function getMetricsSnapshot(): {
  uptimeSec: number;
  requestCount: number;
  errorCount4xx: number;
  errorCount5xx: number;
  avgDurationMs: number;
  externalFailures: number;
} {
  return {
    uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
    requestCount: state.requestCount,
    errorCount4xx: state.errorCount4xx,
    errorCount5xx: state.errorCount5xx,
    avgDurationMs:
      state.requestCount === 0
        ? 0
        : Math.round(state.totalDurationMs / state.requestCount),
    externalFailures: state.externalFailures,
  };
}

/** Test helper */
export function resetMetricsForTests(): void {
  state.requestCount = 0;
  state.errorCount4xx = 0;
  state.errorCount5xx = 0;
  state.totalDurationMs = 0;
  state.externalFailures = 0;
  state.startedAt = Date.now();
}
