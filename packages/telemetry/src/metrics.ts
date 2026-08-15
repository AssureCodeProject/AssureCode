import promClient from 'prom-client';

export const metricsRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegistry, prefix: 'assurecode_' });

/**
 * A note on labels: `contract_id` is deliberately absent from every metric here.
 *
 * Prometheus creates one time series per distinct label combination and keeps
 * it for the process's lifetime. A contract id is unbounded — one new series
 * per contract, forever — so a long-running gateway leaks memory in the client
 * registry and blows up cardinality on the scrape side. Which contract an event
 * belongs to is a tracing and logging concern (both already carry it); metrics
 * answer "how many, how slow", not "which one".
 */
export const ledgerAppendsTotal = new promClient.Counter({
  name: 'assurecode_ledger_appends_total',
  help: 'Total number of Merkle ledger appends',
  labelNames: ['action_type', 'status'],
  registers: [metricsRegistry],
});

export const eventLagGauge = new promClient.Gauge({
  name: 'assurecode_event_lag_seconds',
  help: 'Event bus consumer processing lag in seconds',
  labelNames: ['topic'],
  registers: [metricsRegistry],
});

export const eventBusLagSeconds = new promClient.Histogram({
  name: 'assurecode_event_bus_lag_seconds',
  help: 'Lag in seconds between event emission and consumption',
  labelNames: ['topic'],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export const settlementAmountTotal = new promClient.Counter({
  name: 'assurecode_settlement_amount_cents_total',
  // Minor units — paise under Razorpay/INR, as `escrow.amount_cents` has always
  // stored. The metric name keeps 'cents' so existing series stay continuous.
  help: 'Total settled amount in the currency minor unit (paise for INR)',
  labelNames: ['status'],
  registers: [metricsRegistry],
});

export const settlementAmountDollarsTotal = new promClient.Counter({
  name: 'assurecode_settlement_amount_dollars_total',
  // Deprecated. Settlement is INR under Razorpay, so this counter's name is a
  // lie no help text can fix — divide the cents counter above by 100 instead.
  // Kept registered so a scrape does not suddenly lose a series it has history
  // for; nothing new should increment it.
  help: 'DEPRECATED — settlement is INR; use assurecode_settlement_amount_cents_total / 100',
  labelNames: ['status'],
  registers: [metricsRegistry],
});

export const settlementOperationsTotal = new promClient.Counter({
  name: 'assurecode_settlement_operations_total',
  help: 'Total count of settlement operation attempts by status',
  labelNames: ['status'],
  registers: [metricsRegistry],
});

/**
 * Counter, not Gauge, and named for what it measures.
 *
 * This was a Gauge called `dlq_depth` that only ever had `.inc()` called on it
 * and was never decremented when a DLQ was drained — so it reported a
 * monotonically rising number under a name that promises a current depth. A
 * dashboard reading it as depth would show a queue that never empties. What is
 * actually being counted is messages forwarded to a DLQ, which is a counter.
 */
export const dlqMessagesTotal = new promClient.Counter({
  name: 'assurecode_dlq_messages_total',
  help: 'Total messages forwarded to a Dead Letter Queue stream after exhausting retries',
  labelNames: ['stream'],
  registers: [metricsRegistry],
});

export const sandboxDurationHistogram = new promClient.Histogram({
  name: 'assurecode_sandbox_duration_seconds',
  help: 'CI sandbox execution duration in seconds',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

export const ciSandboxDurationSeconds = new promClient.Histogram({
  name: 'assurecode_ci_sandbox_duration_seconds',
  help: 'Duration of CI sandbox test runs in seconds',
  // `runner` is bounded (docker | node-permission | none); contract_id was not.
  labelNames: ['runner', 'passed'],
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [metricsRegistry],
});

export const llmLatencyHistogram = new promClient.Histogram({
  name: 'assurecode_llm_request_duration_seconds',
  help: 'LLM service request latency in seconds',
  labelNames: ['endpoint', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [metricsRegistry],
});

export const llmRequestsTotal = new promClient.Counter({
  name: 'assurecode_llm_requests_total',
  help: 'Total LLM request count by status',
  labelNames: ['status'],
  registers: [metricsRegistry],
});

export const metrics = {
  ledgerAppendsTotal,
  eventLagGauge,
  eventBusLagSeconds,
  settlementAmountTotal,
  settlementAmountDollarsTotal,
  settlementOperationsTotal,
  dlqMessagesTotal,
  sandboxDurationHistogram,
  ciSandboxDurationSeconds,
  llmLatencyHistogram,
  llmRequestsTotal,
  getMetricsContentType: () => metricsRegistry.contentType,
  getMetrics: () => metricsRegistry.metrics(),
};

export { promClient };
