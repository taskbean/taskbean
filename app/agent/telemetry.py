"""OpenTelemetry setup + UI span/log exporters for the nerd panel."""

from __future__ import annotations
import os
import time
import asyncio
import logging
from collections import deque
from datetime import datetime, timezone
from typing import Any, Sequence

from opentelemetry import trace, metrics
from opentelemetry.sdk.trace import TracerProvider, ReadableSpan
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    SimpleSpanProcessor,
    SpanExporter,
    SpanExportResult,
)
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import (
    BatchLogRecordProcessor,
    LogExporter,
    LogExportResult,
)

logger = logging.getLogger(__name__)

# ── Shared listener system ────────────────────────────────────────────────────

_listeners: set[asyncio.Queue[dict[str, Any]]] = set()
_seq = 0


def _push_event(event: dict[str, Any]) -> None:
    """Push an event dict to all active listener queues."""
    for q in list(_listeners):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass


def _next_seq() -> int:
    global _seq
    _seq += 1
    return _seq


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── Span-name → UI event type mapping ────────────────────────────────────────

_SPAN_EVENT_MAP: dict[str, str] = {
    # Manual spans in main.py
    "file.upload": "upload",
    "extract.tasks": "flow.extract",
    "speech.process": "flow.speech",
    "model.switch": "model.switch",
    # AI spans
    "gen_ai.chat": "ai.response",
    "gen_ai.suggest": "ai.response",
}

_HTTP_METHODS = ("GET ", "POST ", "PUT ", "PATCH ", "DELETE ", "HEAD ", "OPTIONS ")


def _span_to_event_type(span: ReadableSpan) -> str:
    name = span.name
    if name in _SPAN_EVENT_MAP:
        return _SPAN_EVENT_MAP[name]
    # Auto-instrumentation HTTP spans
    attrs = span.attributes or {}
    if name.startswith(_HTTP_METHODS) or "http.route" in attrs:
        return "http.request"
    return name


# ── UISpanExporter ────────────────────────────────────────────────────────────

class UISpanExporter(SpanExporter):
    """Converts completed OTel spans into UI-friendly event dicts and pushes
    them to the asyncio listener system for the nerd panel SSE stream."""

    def __init__(self, maxlen: int = 500) -> None:
        self._buffer: deque[dict[str, Any]] = deque(maxlen=maxlen)

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        for span in spans:
            # Filter out framework noise — only export app-level spans
            if self._is_noise(span):
                continue

            attrs = dict(span.attributes or {})
            event_type = _span_to_event_type(span)

            event: dict[str, Any] = {
                "id": _next_seq(),
                "ts": _now_iso(),
                "type": event_type,
                "spanId": format(span.context.span_id, "016x"),
                "traceId": format(span.context.trace_id, "032x"),
            }
            # Flatten remaining span attributes into the event
            for k, v in attrs.items():
                if not k.startswith("_"):
                    event[k] = v

            self._buffer.append(event)
            _push_event(event)

        return SpanExportResult.SUCCESS

    @staticmethod
    def _is_noise(span: ReadableSpan) -> bool:
        """Whitelist: only let through app-level spans the user cares about."""
        name = span.name
        # Always keep manual app spans
        if name in _SPAN_EVENT_MAP:
            return False
        # Keep user-facing API route spans
        attrs = dict(span.attributes or {})
        route = attrs.get("http.route", "") or attrs.get("http.target", "") or ""
        if any(p in route for p in ("/api/command", "/api/extract", "/api/process-speech", "/api/models/switch", "/api/upload", "/api/transcribe")):
            return False
        # Everything else is framework noise
        return True

    def shutdown(self) -> None:
        pass

    def force_flush(self, timeout_millis: int = 0) -> bool:
        return True

    @property
    def buffer(self) -> deque[dict[str, Any]]:
        return self._buffer


# ── UILogExporter ─────────────────────────────────────────────────────────────

class UILogExporter(LogExporter):
    """Pushes OTel log records to the shared listener system."""

    def export(self, batch: Sequence[Any]) -> LogExportResult:
        for log_record in batch:
            body = log_record.log_record.body or ""
            attrs = dict(log_record.log_record.attributes or {})
            event: dict[str, Any] = {
                "id": _next_seq(),
                "ts": _now_iso(),
                "type": "log.record",
                "severityText": str(log_record.log_record.severity_text or "INFO"),
                "body": str(body),
            }
            # Attach trace context if present
            ctx = log_record.log_record.trace_id
            if ctx:
                event["traceId"] = format(ctx, "032x")
            span_id = log_record.log_record.span_id
            if span_id:
                event["spanId"] = format(span_id, "016x")

            event.update({k: v for k, v in attrs.items() if not k.startswith("_")})
            _push_event(event)
        return LogExportResult.SUCCESS

    def shutdown(self) -> None:
        pass

    def force_flush(self, timeout_millis: int = 0) -> bool:
        return True


# ── OTel provider setup ──────────────────────────────────────────────────────

_ui_span_exporter: UISpanExporter | None = None


def init_otel(service_name: str = "taskbean") -> None:
    global _ui_span_exporter

    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")

    resource = Resource.create({
        "service.name": "taskbean",
        "service.version": "2.0.0",
        "service.instance.id": os.getenv("HOSTNAME", "local"),
        "deployment.environment": os.getenv("ENVIRONMENT", "development"),
    })

    # ── Traces ────────────────────────────────────────────────────────────
    tracer_provider = TracerProvider(resource=resource)

    # UI exporter — SimpleSpanProcessor for immediate delivery
    _ui_span_exporter = UISpanExporter(maxlen=500)
    tracer_provider.add_span_processor(SimpleSpanProcessor(_ui_span_exporter))

    # OTLP exporter — BatchSpanProcessor handles retry internally
    try:
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

        tracer_provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint, insecure=True))
        )
    except Exception:
        logger.info("OTLP trace exporter unavailable — traces only go to UI")

    trace.set_tracer_provider(tracer_provider)

    # ── Metrics ───────────────────────────────────────────────────────────
    try:
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
        reader = PeriodicExportingMetricReader(
            OTLPMetricExporter(endpoint=endpoint, insecure=True),
            export_interval_millis=15_000,
        )
        metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[reader]))
    except Exception:
        metrics.set_meter_provider(MeterProvider(resource=resource))

    # ── Logs ──────────────────────────────────────────────────────────────
    ui_log_exporter = UILogExporter()
    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(BatchLogRecordProcessor(ui_log_exporter))

    otel_handler = LoggingHandler(level=logging.DEBUG, logger_provider=logger_provider)
    logging.getLogger().addHandler(otel_handler)

    # ── Instrument httpx ──────────────────────────────────────────────────
    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        HTTPXClientInstrumentor().instrument()
    except ImportError:
        logger.info("opentelemetry-instrumentation-httpx not installed — httpx calls won't be traced")


# ── Module-level instruments ──────────────────────────────────────────────────

tracer = trace.get_tracer("taskbean", "2.0.0")
meter  = metrics.get_meter("taskbean", "2.0.0")

ai_call_counter      = meter.create_counter("ai.calls",        description="Total AI calls")
ai_error_counter     = meter.create_counter("ai.errors",       description="Total AI errors")
task_extract_counter = meter.create_counter("tasks.extracted",  description="Tasks extracted from text")
command_counter      = meter.create_counter("commands",         description="NL commands processed")
file_upload_counter  = meter.create_counter("file.uploads",     description="File uploads")
reminder_counter     = meter.create_counter("reminders.fired",  description="Reminders fired")
todo_gauge           = meter.create_up_down_counter("todos.active", description="Active (incomplete) todos")
ai_latency           = meter.create_histogram("ai.latency_ms",      description="AI call latency (ms)")
extract_latency      = meter.create_histogram("extract.latency_ms",  description="Extract flow latency (ms)")
speech_latency       = meter.create_histogram("speech.latency_ms",   description="Speech flow latency (ms)")
command_latency      = meter.create_histogram("command.latency_ms",  description="Command flow latency (ms)")

# ── Constants ─────────────────────────────────────────────────────────────────

SERVER_START = int(time.time() * 1000)


def snapshot(limit: int = 50) -> list[dict[str, Any]]:
    if _ui_span_exporter is not None:
        items = list(_ui_span_exporter.buffer)
    else:
        items = []
    return items[-limit:]


def subscribe() -> asyncio.Queue[dict[str, Any]]:
    q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=500)
    _listeners.add(q)
    return q


def unsubscribe(q: asyncio.Queue[dict[str, Any]]) -> None:
    _listeners.discard(q)


# ── FastAPI instrumentation ───────────────────────────────────────────────────

def instrument_fastapi(app: Any) -> None:
    """Instrument a FastAPI app for automatic per-route tracing."""
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        FastAPIInstrumentor.instrument_app(app)
    except ImportError:
        logger.warning("opentelemetry-instrumentation-fastapi not installed — skipping auto-instrumentation")
