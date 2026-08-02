import promClient from 'prom-client';

export const metricsRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegistry, prefix: 'assurecode_' });

export const ledgerAppendsTotal = new promClient.Counter({
  name: 'assurecode_ledger_appends_total',
  help: 'Total number of Merkle ledger appends',
  labelNames: ['action_type', 'status', 'contract_id'],
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
  help: 'Total settled amount in cents',
  labelNames: ['status'],
  registers: [metricsRegistry],
});

export const settlementAmountDollarsTotal = new promClient.Counter({
  name: 'assurecode_settlement_amount_dollars_total',
  help: 'Total dollars settled via Stripe transfer',
  labelNames: ['status'],
  registers: [metricsRegistry],
});

export const settlementOperationsTotal = new promClient.Counter({
  name: 'assurecode_settlement_operations_total',
  help: 'Total count of settlement operation attempts by status',
  labelNames: ['status'],
  registers: [metricsRegistry],
});

export const dlqDepth = new promClient.Gauge({
  name: 'assurecode_dlq_depth',
  help: 'Number of messages currently in Dead Letter Queue (DLQ) streams',
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
  labelNames: ['contract_id', 'passed'],
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
  dlqDepth,
  sandboxDurationHistogram,
  ciSandboxDurationSeconds,
  llmLatencyHistogram,
  llmRequestsTotal,
  getMetricsContentType: () => metricsRegistry.contentType,
  getMetrics: () => metricsRegistry.metrics(),
};

export { promClient };
