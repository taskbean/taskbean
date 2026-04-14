import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SimpleSpanProcessor, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { DiagConsoleLogger, DiagLogLevel, diag, trace, metrics, SpanStatusCode } from '@opentelemetry/api';

// ── UISpanExporter ─────────────────────────────────────────────────────
// Mirrors the Python UISpanExporter: converts completed OTel spans into
// UI-friendly JSON events, buffers them, and pushes to SSE listeners.

class UISpanExporter {
  constructor(maxLen = 500) {
    this._buffer = [];
    this._maxLen = maxLen;
    this._listeners = new Set(); // Set<express.Response> for SSE
    this._seq = 0;
  }

  export(spans, resultCallback) {
    for (const span of spans) {
      // Filter out framework noise — only export app-level spans
      if (this._isNoise(span)) continue;

      this._seq++;
      const event = this._spanToEvent(span);
      this._buffer.push(event);
      if (this._buffer.length > this._maxLen) this._buffer.shift();

      for (const res of this._listeners) {
        try { res.write(`data: ${JSON.stringify(event)}\n\n`); }
        catch { this._listeners.delete(res); }
      }
    }
    resultCallback({ code: 0 }); // ExportResultCode.SUCCESS
  }

  /** Whitelist: only let through app-level spans the user cares about. */
  _isNoise(span) {
    const name = span.name || '';
    // Always keep manual app spans (these are the ones we care about)
    if (name === 'ai.complete' || name === 'ai.completeWithTools') return false;
    if (name.startsWith('tool.')) return false;
    if (name === 'mcp.convertFile') return false;
    if (name === 'model.switch') return false;
    // Everything else is framework/infrastructure noise
    return true;
  }

  _spanToEvent(span) {
    const ctx = span.spanContext();
    const attrs = span.attributes || {};
    const durationMs = span.duration
      ? Math.round(span.duration[0] * 1000 + span.duration[1] / 1e6)
      : 0;
    const startTime = new Date(
      span.startTime[0] * 1000 + span.startTime[1] / 1e6,
    );

    const event = {
      id: this._seq,
      ts: startTime.toISOString(),
      type: this._classifySpan(span.name, attrs),
      spanId: ctx.spanId,
      traceId: ctx.traceId,
      spanName: span.name,
      durationMs,
    };

    // Flatten span attributes into the event
    for (const [k, v] of Object.entries(attrs)) {
      if (!k.startsWith('_')) event[k] = v;
    }

    // Add span events as nested data
    if (span.events?.length) {
      event.spanEvents = span.events.map(e => ({
        name: e.name,
        ts: new Date(e.time[0] * 1000 + e.time[1] / 1e6).toISOString(),
        attributes: e.attributes || {},
      }));
    }

    return event;
  }

  _classifySpan(name, attrs) {
    if (name === 'ai.complete' || name === 'ai.completeWithTools') return 'ai.response';
    if (name.startsWith('tool.')) return 'tool.executed';
    if (name === 'mcp.convertFile') return 'upload';
    if (name === 'model.switch') return 'model.switch.done';
    if (/^(GET|POST|PATCH|DELETE) /.test(name)) return 'http.request';
    if (attrs['http.route']) return 'http.request';
    return name;
  }

  snapshot(limit = 50) {
    return this._buffer.slice(-limit);
  }

  subscribe(res) {
    this._listeners.add(res);
  }

  unsubscribe(res) {
    this._listeners.delete(res);
  }

  clear() {
    this._buffer.length = 0;
    this._seq = 0;
  }

  shutdown() { return Promise.resolve(); }
  forceFlush() { return Promise.resolve(); }
}

// ── Metric snapshot tracking ───────────────────────────────────────────
// OTel counters are monotonic; we mirror values here for the nerd panel.

const _metricValues = {
  aiCalls: 0, commands: 0, tasks: 0, uploads: 0, errors: 0,
};

function incMetric(key, amount = 1) {
  if (key in _metricValues) _metricValues[key] += amount;
}

function getMetricSnapshot() {
  return { ..._metricValues };
}

// ── OTel SDK setup ─────────────────────────────────────────────────────

const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317';

if (process.env.OTEL_DIAG === 'true') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
}

const resource = resourceFromAttributes({
    'service.name': 'taskbean',
    'service.version': '1.0.0',
    'deployment.environment': 'local',
});

const traceExporter = new OTLPTraceExporter({ url: OTEL_ENDPOINT });
const metricExporter = new OTLPMetricExporter({ url: OTEL_ENDPOINT });

const uiExporter = new UISpanExporter(500);

const sdk = new NodeSDK({
    resource,
    spanProcessors: [
        new SimpleSpanProcessor(uiExporter),
        new BatchSpanProcessor(traceExporter),
    ],
    metricReader: new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 30_000,
    }),
    instrumentations: [
        getNodeAutoInstrumentations({
            '@opentelemetry/instrumentation-http': { enabled: true },
            '@opentelemetry/instrumentation-express': { enabled: true },
            '@opentelemetry/instrumentation-undici': { enabled: true },
            '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
    ],
});

sdk.start();
console.log(`📊 OTel initialized → ${OTEL_ENDPOINT} (traces export if collector is running)`);

process.on('SIGTERM', () => sdk.shutdown());
process.on('SIGINT', () => sdk.shutdown());

// ── Custom tracer & meter for app-level instrumentation ────────────────

const tracer = trace.getTracer('taskbean', '1.0.0');
const meter = metrics.getMeter('taskbean', '1.0.0');

// Counters
const taskExtractCounter = meter.createCounter('tasks.extracted', { description: 'Total tasks extracted from text' });
const commandCounter = meter.createCounter('commands.processed', { description: 'NL commands processed' });
const reminderFiredCounter = meter.createCounter('reminders.fired', { description: 'Reminders that fired notifications' });
const aiCallCounter = meter.createCounter('ai.calls', { description: 'Calls to Foundry Local model' });
const aiErrorCounter = meter.createCounter('ai.errors', { description: 'AI call errors' });
const fileUploadCounter = meter.createCounter('files.uploaded', { description: 'Files uploaded for conversion' });

// Histograms
const aiLatency = meter.createHistogram('ai.latency_ms', { description: 'AI inference latency in ms', unit: 'ms' });
const extractLatency = meter.createHistogram('extract.latency_ms', { description: 'Task extraction latency (paste/file)', unit: 'ms' });
const speechLatency = meter.createHistogram('speech.latency_ms', { description: 'Speech-to-task extraction latency', unit: 'ms' });
const commandLatency = meter.createHistogram('command.latency_ms', { description: 'Command processing latency', unit: 'ms' });

// Gauges
const todoGauge = meter.createUpDownCounter('todos.active', { description: 'Active (incomplete) todos' });

export {
    tracer, SpanStatusCode,
    // OTel instruments
    taskExtractCounter, commandCounter, reminderFiredCounter,
    aiCallCounter, aiErrorCounter, fileUploadCounter,
    aiLatency, extractLatency, speechLatency, commandLatency, todoGauge,
    // UI exporter
    uiExporter,
    // Metric tracking
    incMetric, getMetricSnapshot,
};
