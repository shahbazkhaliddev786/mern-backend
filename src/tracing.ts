// Request tracing (spec 017). Imported first by both entry points, so the HTTP and MongoDB
// instrumentations patch those modules before anything loads them. Keep this file free of
// app imports beyond config: the logger's MongoDB transport would load the driver too early.
//
// On when LangSmith tracing is on or an OTLP endpoint is set; otherwise nothing is registered.
// Spans come from the instrumentations and from the agent's own code (graph.ts, chat.service.ts).
// They carry ids, names and numbers, never message text; prompts go to LangSmith through
// LangChain's own tracing instead.

import { context, propagation, trace } from '@opentelemetry/api';
import { NodeSDK, resources, tracing as sdkTracing } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { LangSmithOTLPTraceExporter } from 'langsmith/experimental/otel/exporter';
import config from './config/config.js';

let sdk: NodeSDK | null = null;
let processors: sdkTracing.SpanProcessor[] = [];

/**
 * Starts tracing with the given exporters. `immediate` exports each span as it ends, for tests;
 * otherwise spans are batched. Calling it again does nothing.
 */
export function startTracing(exporters: sdkTracing.SpanExporter[], { immediate = false } = {}): void {
  if (sdk) return;
  processors = exporters.map((exporter) => (immediate ? new sdkTracing.SimpleSpanProcessor(exporter) : new sdkTracing.BatchSpanProcessor(exporter)));
  sdk = new NodeSDK({
    resource: resources.resourceFromAttributes({ 'service.name': 'aljo-store-backend', 'deployment.environment.name': config.ENV }),
    spanProcessors: processors,
    // No statement capture: MongoDB spans name the operation and collection, never query values.
    instrumentations: [new HttpInstrumentation(), new MongoDBInstrumentation({ enhancedDatabaseReporting: false })],
  });
  // OpenTelemetry's registrations are process-wide and can't be replaced once set. Clearing them
  // first makes this the one in force (at start-up there's nothing to clear; in tests, a previous
  // file's may linger).
  trace.disable();
  context.disable();
  propagation.disable();
  sdk.start();
}

/** The exporters the environment asks for: LangSmith's OTLP endpoint, and/or a general backend. */
export function configuredExporters(): sdkTracing.SpanExporter[] {
  const exporters: sdkTracing.SpanExporter[] = [];
  if (config.LANGSMITH_TRACING === 'true' && config.LANGSMITH_API_KEY) {
    exporters.push(new LangSmithOTLPTraceExporter({ apiKey: config.LANGSMITH_API_KEY, projectName: config.LANGSMITH_PROJECT }));
  }
  if (config.OTEL_EXPORTER_OTLP_ENDPOINT) exporters.push(new OTLPTraceExporter());
  return exporters;
}

const exporters = configuredExporters();
if (exporters.length > 0) startTracing(exporters);

export const isTracingOn = (): boolean => sdk !== null;

/**
 * Stops tracing and releases OpenTelemetry's process-wide registrations, so another test file
 * running in the same worker can start its own. For tests.
 */
export async function stopTracing(timeoutMs = 1000): Promise<void> {
  if (!sdk) return;
  const stopping = sdk;
  sdk = null;
  processors = [];
  let timer: NodeJS.Timeout | undefined;
  try {
    // Shutdown flushes first; an exporter that never answers mustn't keep the registrations alive.
    await Promise.race([stopping.shutdown(), new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
  } catch {
    // Released below either way.
  } finally {
    clearTimeout(timer);
    trace.disable();
    context.disable();
    propagation.disable();
  }
}

/**
 * Sends buffered spans before a response ends: a Vercel function can be frozen right after.
 * Waits at most `timeoutMs`, and never throws.
 */
export async function flushTraces(timeoutMs = 2000): Promise<void> {
  if (!sdk) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), timeoutMs)));
  try {
    const result = await Promise.race([Promise.all(processors.map((processor) => processor.forceFlush())), timeout]);
    if (result === 'timeout') await logWarning('TRACE_FLUSH_TIMEOUT', { timeoutMs });
  } catch (error) {
    await logWarning('TRACE_FLUSH_FAILED', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    clearTimeout(timer);
  }
}

// Loaded on use, long after start-up: importing the logger here would load the MongoDB driver early.
async function logWarning(event: string, meta: Record<string, unknown>): Promise<void> {
  const { default: logger } = await import('./utils/logger.js');
  logger.warn(event, meta);
}
