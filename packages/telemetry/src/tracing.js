import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { trace } from '@opentelemetry/api';

let sdkInstance = null;

export function initTracing(serviceName) {
  if (!sdkInstance) {
    const collectorUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317';
    const traceExporter = new OTLPTraceExporter({ url: collectorUrl });

    sdkInstance = new NodeSDK({
      resource: new Resource({
        [ATTR_SERVICE_NAME]: serviceName,
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
      console.warn({ msg: 'OTel SDK start warning', serviceName, err });
    }

    process.on('SIGTERM', () => {
      sdkInstance?.shutdown().catch(() => {}).finally(() => process.exit(0));
    });
  }

  return trace.getTracer(serviceName);
}

export { trace };
