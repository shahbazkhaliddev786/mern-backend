import { afterAll, describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
import type { tracing as sdkTracing } from '@opentelemetry/sdk-node';
import { flushTraces, isTracingOn, startTracing, stopTracing } from './tracing';

afterAll(() => stopTracing());

describe('tracing setup (spec 017)', () => {
  it('is off unless LangSmith tracing or an OTLP endpoint is configured', async () => {
    expect(isTracingOn()).toBe(false);
    await expect(flushTraces()).resolves.toBeUndefined(); // a no-op when off
  });

  it('gives up flushing after the time limit when the exporter hangs', async () => {
    const hanging: sdkTracing.SpanExporter = { export: () => {}, shutdown: async () => {} };
    startTracing([hanging]);
    expect(isTracingOn()).toBe(true);
    trace.getTracer('test').startSpan('pending').end();
    const started = Date.now();
    await flushTraces(300);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
