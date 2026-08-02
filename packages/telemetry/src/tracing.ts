import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Resource } from '@opentelemetry/resources';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { trace, type Tracer } from '@opentelemetry/api';

let sdkInstance: NodeSDK | null = null;

export function initTracing(serviceName: string): Tracer {
  if (!sdkInstance) {
    const collectorUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317';
    const traceExporter = new OTLPTraceExporter({ url: collectorUrl });

    sdkInstance = new NodeSDK({
      resource: new Resource({
        'service.name': serviceName,
      }),
      traceExporter,
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
      // Use a single object arg so a non-literal in `serviceName` cannot be
      // interpreted as a printf-style format specifier by console.warn.
      console.warn({ msg: 'OTel SDK start warning', serviceName, err });
    }

    process.on('SIGTERM', () => {
      sdkInstance?.shutdown().catch(() => {}).finally(() => process.exit(0));
    });
  }

  return trace.getTracer(serviceName);
}

export { trace };
