import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';

let sdkInstance = null;

export function initTelemetry(serviceName) {
  if (sdkInstance) return sdkInstance;

  const exporterUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317';
  const exporter = new OTLPTraceExporter({
    url: exporterUrl,
  });

  sdkInstance = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
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
    console.warn({ msg: 'OTel SDK start warning', serviceName, err });
  }

  process.on('SIGTERM', () => {
    sdkInstance?.shutdown().catch((err) => console.error('[telemetry] Shutdown error:', err));
  });

  return sdkInstance;
}

export const initTracing = initTelemetry;
