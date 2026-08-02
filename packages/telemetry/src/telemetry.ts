import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Resource } from '@opentelemetry/resources';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';

let sdkInstance: NodeSDK | null = null;

export function initTelemetry(serviceName: string): NodeSDK {
  if (sdkInstance) return sdkInstance;

  const exporterUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317';
  const exporter = new OTLPTraceExporter({
    url: exporterUrl,
  });

  sdkInstance = new NodeSDK({
    resource: new Resource({
      'service.name': serviceName,
    }),
    traceExporter: exporter,
    instrumentations: [
      new HttpInstrumentation(),
      new FastifyInstrumentation(),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });

  try {
    sdkInstance.start();
  } catch (err) {
    // Single object arg so a non-literal in `serviceName` cannot be
    // interpreted as a printf-style format specifier by console.warn.
    console.warn({ msg: 'OTel SDK start warning', serviceName, err });
  }

  process.on('SIGTERM', () => {
    sdkInstance?.shutdown().catch((err) => console.error('[telemetry] Shutdown error:', err));
  });

  return sdkInstance;
}

export const initTracing = initTelemetry;
