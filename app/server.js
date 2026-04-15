// OTel must be imported first before any other modules
import {
    tracer, taskExtractCounter, commandCounter, reminderFiredCounter,
    aiCallCounter, aiErrorCounter, fileUploadCounter,
    aiLatency, extractLatency, speechLatency, commandLatency, todoGauge, SpanStatusCode,
    uiExporter, incMetric, getMetricSnapshot
} from './telemetry.js';
import { trace } from '@opentelemetry/api';

import express from 'express';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import multer from 'multer';
import jsonpatch from 'fast-json-patch';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FoundryLocalManager, ResponsesClient, getOutputText } from 'foundry-local-sdk';
import Database from 'better-sqlite3';
import {
    dbGetAllTodos, dbGetTodo, dbInsertTodo, dbUpdateTodo, dbDeleteTodo,
    dbGetAllTemplates, dbGetTemplate, dbInsertTemplate, dbUpdateTemplate, dbDeleteTemplate,
    getAllConfig, getConfig, setConfig, migrateJsonConfig,
    dbClearTelemetry,
    dbSaveMessage, dbGetThread,
    DB_PATH
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let MODEL_ID = 'phi-4-mini-instruct-vitis-npu:2';
// Port 2326 — spell B-E-A-N on a rotary phone
const DEFAULT_PORT = 2326;
let EXPRESS_PORT = process.env.taskbean_PORT ? parseInt(process.env.taskbean_PORT, 10) : DEFAULT_PORT;
let TZ = 'America/Los_Angeles';

// ════════════════════════════════════════════════════════════════════════════
// Server-side config (persisted to disk)
// ════════════════════════════════════════════════════════════════════════════

const CONFIG_PATH = path.join(__dirname, '.taskbean-config.json');
migrateJsonConfig(CONFIG_PATH); // one-time migration from JSON → SQLite

function saveServerConfig(cfg) {
    for (const [k, v] of Object.entries(cfg)) setConfig(k, v);
}

const serverConfig = getAllConfig();
if (serverConfig.timezone) TZ = serverConfig.timezone;
if (serverConfig.modelId) MODEL_ID = serverConfig.modelId;

// ════════════════════════════════════════════════════════════════════════════
// Hardware detection (cached static profile + live CPU/RAM)
// ════════════════════════════════════════════════════════════════════════════

let _hwStatic = null;   // detected once on first call
let _prevCpuTimes = null;

function _sampleCpuTimes() {
    const cpus = os.cpus();
    return cpus.reduce((a, c) => {
        a.idle += c.times.idle;
        a.total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
        return a;
    }, { idle: 0, total: 0 });
}

function getCpuUsage() {
    const curr = _sampleCpuTimes();
    if (!_prevCpuTimes) { _prevCpuTimes = curr; return 0; }
    const idleDelta = curr.idle - _prevCpuTimes.idle;
    const totalDelta = curr.total - _prevCpuTimes.total;
    _prevCpuTimes = curr;
    return totalDelta > 0 ? +((1 - idleDelta / totalDelta) * 100).toFixed(1) : 0;
}

// Prime the first CPU sample on boot
getCpuUsage();

function detectGpu() {
    if (process.platform !== 'win32') return null;
    try {
        const out = execSync(
            'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress"',
            { encoding: 'utf8', timeout: 10_000, stdio: ['pipe', 'pipe', 'ignore'] }
        );
        const parsed = JSON.parse(out);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        let best = null;
        for (const g of list) {
            if (!g.Name || /basic display|microsoft basic|remote desktop/i.test(g.Name)) continue;
            const vramGb = +(g.AdapterRAM / (1024 ** 3)).toFixed(2);
            if (!best || vramGb > best.vramGb) best = { name: g.Name, vramGb };
        }
        return best;
    } catch { return null; }
}

function detectNpu() {
    if (process.platform !== 'win32') return null;
    try {
        const out = execSync(
            'powershell -NoProfile -Command "Get-PnpDevice -Status OK | Where-Object { $_.FriendlyName -match \'\\bNPU\\b|Neural|AI Accelerator\' } | Select-Object -ExpandProperty FriendlyName"',
            { encoding: 'utf8', timeout: 15_000, stdio: ['pipe', 'pipe', 'ignore'] }
        );
        const lines = out.trim().split('\n').map(l => l.trim()).filter(Boolean);
        const npuLine = lines.find(l => /\bNPU\b|Neural|AI Accelerator/i.test(l));
        // Return name only at boot; LUID is discovered asynchronously after startup
        return npuLine ? { name: npuLine, luid: null } : null;
    } catch { return null; }
}

// ── NPU utilization sampler (background async polling) ──────────────────
let _npuUsagePercent = 0;
let _npuSamplerRunning = false;
let _npuSampleInFlight = false;

function _startNpuSampler(luid) {
    if (_npuSamplerRunning || !luid) return;
    _npuSamplerRunning = true;
    const counterFilter = `\\GPU Engine(pid_*_luid_${luid}*)\\Utilization Percentage`;

    function scheduleNext() {
        setTimeout(sample, 3000);
    }

    function sample() {
        if (_npuSampleInFlight) return scheduleNext();
        _npuSampleInFlight = true;
        const psCmd = `powershell -NoProfile -Command "(Get-Counter '${counterFilter}' -ErrorAction SilentlyContinue).CounterSamples | Measure-Object -Property CookedValue -Sum | Select-Object -ExpandProperty Sum"`;
        exec(psCmd, { timeout: 8_000 }, (err, stdout) => {
            _npuSampleInFlight = false;
            if (err) { scheduleNext(); return; }
            const val = parseFloat(stdout.trim());
            _npuUsagePercent = isNaN(val) ? 0 : Math.min(100, Math.max(0, +(val.toFixed(1))));
            scheduleNext();
        });
    }

    // Prime first sample
    sample();
}

// Deferred NPU LUID discovery — runs after server is accepting requests
function _deferNpuLuidDiscovery() {
    if (!_hwStatic?.npu || _hwStatic.npu.luid) return;
    // Run the heavy PDH query in a child process to avoid blocking the event loop
    setTimeout(() => {
        const psCmd = "powershell -NoProfile -Command \"(Get-Counter '\\GPU Engine(*)\\Utilization Percentage').CounterSamples | Select-Object -Property InstanceName | ConvertTo-Json -Compress\"";
        exec(psCmd, { timeout: 20_000 }, (err, stdout) => {
            if (err || !stdout.trim()) return;
            try {
                const data = JSON.parse(stdout);
                const adapters = {};
                for (const item of data) {
                    const m = item.InstanceName.match(/^pid_\d+_luid_(0x\w+_0x\w+)_phys_\d+_eng_\d+_engtype_(.+)$/);
                    if (!m) continue;
                    const [, luid, engtype] = m;
                    if (!adapters[luid]) adapters[luid] = new Set();
                    adapters[luid].add(engtype.trim());
                }
                const candidates = [];
                for (const [luid, engs] of Object.entries(adapters)) {
                    const has3d = [...engs].some(e => e.includes('3d'));
                    const hasCopy = [...engs].some(e => e.includes('copy'));
                    const hasVideo = [...engs].some(e => e.includes('video'));
                    const hasCompute = [...engs].some(e => e.includes('compute'));
                    if (hasCompute && !has3d && !hasCopy && !hasVideo) candidates.push(luid);
                }
                if (candidates.length === 1 && _hwStatic?.npu) {
                    console.log(`⚡ NPU LUID detected: ${candidates[0]} (engines: ${[...adapters[candidates[0]]].join(', ')})`);
                    _hwStatic.npu.luid = candidates[0];
                    _startNpuSampler(candidates[0]);
                } else if (candidates.length > 1) {
                    console.warn(`⚠ Multiple compute-only adapters found (${candidates.join(', ')}), skipping NPU usage monitoring`);
                }
            } catch (e) {
                console.warn('NPU LUID discovery failed:', e.message);
            }
        });
    }, 2000); // 2s after boot — server is already serving
}

function detectHardwareStatic() {
    if (_hwStatic) return _hwStatic;
    const cpuInfo = os.cpus()[0];
    _hwStatic = {
        cpu: { cores: os.cpus().length, model: cpuInfo?.model?.trim() || 'Unknown' },
        ram: { totalGb: +(os.totalmem() / (1024 ** 3)).toFixed(1) },
        gpu: detectGpu(),
        npu: detectNpu(),
    };
    console.log(`🔧 Hardware: ${_hwStatic.cpu.cores} cores, ${_hwStatic.ram.totalGb} GB RAM, GPU: ${_hwStatic.gpu?.name || 'none'} (${_hwStatic.gpu?.vramGb || 0} GB), NPU: ${_hwStatic.npu?.name || 'none'}`);
    // Defer LUID discovery + sampler startup so boot isn't blocked by ~5s PDH query
    _deferNpuLuidDiscovery();
    return _hwStatic;
}

function getHardwareSnapshot() {
    const hw = detectHardwareStatic();
    return {
        ...hw,
        cpu: { ...hw.cpu, usagePercent: getCpuUsage() },
        ram: {
            ...hw.ram,
            usedGb: +((os.totalmem() - os.freemem()) / (1024 ** 3)).toFixed(1),
            freeGb: +(os.freemem() / (1024 ** 3)).toFixed(1),
            usagePercent: +((1 - os.freemem() / os.totalmem()) * 100).toFixed(1),
        },
        npu: hw.npu ? { ...hw.npu, usagePercent: _npuUsagePercent } : null,
    };
}

function getMaxModelGb(device, hw) {
    const d = (device || '').toUpperCase();
    if (d === 'NPU') return hw.npu ? 6.0 : 0;
    if (d === 'GPU') return hw.gpu ? hw.gpu.vramGb * 0.85 : 0;
    return hw.ram.totalGb * 0.60;
}

// Detect on boot (async-safe — runs sync shell commands)
detectHardwareStatic();

// ════════════════════════════════════════════════════════════════════════════
// In-memory stores
// ════════════════════════════════════════════════════════════════════════════

// Todos are now backed by SQLite — load into memory for fast access
// and sync back on every mutation
let todos = dbGetAllTodos();
let recurringTemplates = dbGetAllTemplates();  // { id, title, emoji, intervalMs, lastFired }

// Periodically re-read todos from DB to pick up CLI agent writes
setInterval(() => { todos = dbGetAllTodos(); }, 5000);

// ════════════════════════════════════════════════════════════════════════════
// Telemetry ring buffer — mirrors selected server events for the nerd-mode UI.
// OTLP export is unchanged; this is an additive in-process copy.
// ════════════════════════════════════════════════════════════════════════════

const SERVER_START = Date.now();

function nowPacific() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

function getTimeOfDay() {
    const h = nowPacific().getHours();
    if (h < 6) return 'night';
    if (h < 12) return 'morning';
    if (h < 17) return 'afternoon';
    if (h < 21) return 'evening';
    return 'night';
}

function addTodo(title, dueDate, dueTime, source, emoji, priority, notes, tags) {
    const validPriorities = ['high', 'medium', 'low', 'none'];
    const todo = {
        id: randomUUID(),
        title,
        emoji: emoji || null,
        dueDate: dueDate || null,
        dueTime: dueTime || null,
        completed: false,
        reminder: false,
        remindAt: null,
        reminderFired: false,
        source: source || 'manual',
        priority: validPriorities.includes(priority) ? priority : 'none',
        notes: notes ? String(notes).slice(0, 5000) : null,
        tags: Array.isArray(tags) ? [...new Set(tags.slice(0, 10))] : [],
        createdAt: new Date().toISOString()
    };
    todos.push(todo);
    dbInsertTodo(todo);
    todoGauge.add(1, { source: source || 'manual' });
    return todo;
}

function setReminder(todoId, remindAt) {
    const todo = todos.find(t => t.id === todoId);
    if (!todo) return null;
    todo.reminder = true;
    todo.remindAt = remindAt;
    todo.reminderFired = false;
    dbUpdateTodo(todo);
    return todo;
}

// ════════════════════════════════════════════════════════════════════════════
// Built-in recurring reminder templates (the fun stuff)
// ════════════════════════════════════════════════════════════════════════════

const BUILT_IN_TEMPLATES = [
    { title: 'Touch grass 🌿', emoji: '🌿', intervalMin: 120, description: 'Go outside. Feel the sun. Remember you have legs.' },
    { title: 'Stand up & stretch 🧘', emoji: '🧘', intervalMin: 60, description: 'Your spine called. It said "please".' },
    { title: 'Drink water 💧', emoji: '💧', intervalMin: 45, description: 'Hydrate or diedrate. Your call.' },
    { title: 'Look away from screen 👀', emoji: '👀', intervalMin: 20, description: '20-20-20 rule: 20 sec, 20 ft away, blink 20 times.' },
    { title: 'Take a deep breath 🫁', emoji: '🫁', intervalMin: 30, description: 'In through the nose... hold... out through the mouth. You\'re doing great.' },
    { title: 'Check your posture 🪑', emoji: '🪑', intervalMin: 40, description: 'Shoulders back, chin up. You look like a question mark.' },
    { title: 'Snack time 🍎', emoji: '🍎', intervalMin: 180, description: 'Fuel the machine. Preferably not just coffee.' },
];

function activateRecurringTemplate(template) {
    const existing = recurringTemplates.find(r => r.title === template.title);
    if (existing) { existing.active = true; dbUpdateTemplate(existing); return existing; }

    const rec = {
        id: randomUUID(),
        title: template.title,
        emoji: template.emoji,
        description: template.description,
        intervalMin: template.intervalMin,
        intervalMs: template.intervalMin * 60_000,
        active: true,
        lastFired: Date.now()
    };
    recurringTemplates.push(rec);
    dbInsertTemplate(rec);
    return rec;
}

function deactivateRecurringTemplate(id) {
    const rec = recurringTemplates.find(r => r.id === id);
    if (rec) { rec.active = false; dbUpdateTemplate(rec); }
    return rec;
}

// ════════════════════════════════════════════════════════════════════════════
// Reminder & recurring scheduler
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// Open-Meteo weather (no API key)
// ════════════════════════════════════════════════════════════════════════════

async function getWeather(lat = 47.674, lon = -122.121) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,precipitation&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=${encodeURIComponent(TZ)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Weather API ${res.status}`);
    const data = await res.json();
    const c = data.current;
    const codes = {
        0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
        45: 'Foggy', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle',
        55: 'Dense drizzle', 61: 'Slight rain', 63: 'Rain', 65: 'Heavy rain',
        71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Rain showers',
        81: 'Moderate showers', 82: 'Heavy showers', 95: 'Thunderstorm',
    };
    const rainy = [51,53,55,61,63,65,80,81,82,95];
    return {
        temperature: `${c.temperature_2m}°F`,
        feelsLike: `${c.apparent_temperature}°F`,
        condition: codes[c.weather_code] || `Code ${c.weather_code}`,
        humidity: `${c.relative_humidity_2m}%`,
        wind: `${c.wind_speed_10m} mph`,
        precipitation: `${c.precipitation} mm`,
        jacketAdvice: c.apparent_temperature < 55 || c.precipitation > 0 || rainy.includes(c.weather_code)
            ? 'Yes, bring a jacket!' : 'Nah, you\'re good without a jacket.',
        umbrellaAdvice: rainy.includes(c.weather_code) ? 'Grab an umbrella!' : 'No umbrella needed.',
    };
}

// ════════════════════════════════════════════════════════════════════════════
// Tool definitions (NL commands via Responses API tool calling)
// ════════════════════════════════════════════════════════════════════════════
// Tool definitions for native OpenAI-style tool calling
// ════════════════════════════════════════════════════════════════════════════

// Informational-only tools — calling these does not mutate todo state.
// Listed last so small models with ordering bias prefer mutation tools first.
const INFORMATIONAL_TOOLS = new Set(['get_current_datetime', 'get_weather']);

const NL_TOOLS = [
    {
        name: 'add_task',
        description: 'Add a plain task or todo item (no timed reminder). Use whenever the user wants to add, create, or save something to their list.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                due_date: { type: 'string', description: 'YYYY-MM-DD if known' },
                due_time: { type: 'string', description: 'HH:MM if known' },
                emoji: { type: 'string', description: 'A fun emoji' }
            },
            required: ['title']
        }
    },
    {
        name: 'set_reminder',
        description: 'Create a task with a timed Windows notification. Use for "remind me to..." requests.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Reminder text' },
                remind_at: { type: 'string', description: 'ISO 8601 datetime with Pacific offset, e.g. "2026-04-09T17:00:00-07:00"' },
                due_date: { type: 'string', description: 'YYYY-MM-DD' },
                due_time: { type: 'string', description: 'HH:MM (24h)' },
                emoji: { type: 'string', description: 'A fun emoji for the reminder' }
            },
            required: ['title', 'remind_at']
        }
    },
    {
        name: 'mark_complete',
        description: 'Mark a todo as done.',
        parameters: {
            type: 'object',
            properties: { todo_id: { type: 'string', description: 'Todo ID' } },
            required: ['todo_id']
        }
    },
    {
        name: 'mark_incomplete',
        description: 'Re-open a completed todo.',
        parameters: {
            type: 'object',
            properties: { todo_id: { type: 'string', description: 'Todo ID' } },
            required: ['todo_id']
        }
    },
    {
        name: 'remove_task',
        description: 'Delete a todo.',
        parameters: {
            type: 'object',
            properties: { todo_id: { type: 'string' } },
            required: ['todo_id']
        }
    },
    {
        name: 'update_task',
        description: 'Update an existing todo\'s fields. Only provided fields are changed. Use for rename, reschedule, edit, change priority, add notes requests.',
        parameters: {
            type: 'object',
            properties: {
                todo_id: { type: 'string', description: 'Todo ID to update' },
                title: { type: 'string', description: 'New title' },
                due_date: { type: 'string', description: 'New due date (YYYY-MM-DD), or "clear" to remove' },
                due_time: { type: 'string', description: 'New due time (HH:MM 24h), or "clear" to remove' },
                priority: { type: 'string', description: 'Priority: high, medium, low, or none' },
                notes: { type: 'string', description: 'Notes in markdown format, or "clear" to remove' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Replace tags with this list' },
                emoji: { type: 'string', description: 'New emoji' }
            },
            required: ['todo_id']
        }
    },
    {
        name: 'create_recurring_reminder',
        description: 'Create a custom recurring reminder that fires at a set interval. Use when users say "remind me every X minutes/hours to Y" or "set up a recurring reminder".',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Short reminder text' },
                emoji: { type: 'string', description: 'A fun emoji for the reminder' },
                interval_min: { type: 'number', description: 'How often to remind, in minutes (e.g. 30 for every 30 min, 60 for hourly)' },
                description: { type: 'string', description: 'Optional longer description' }
            },
            required: ['title', 'interval_min']
        }
    },
    {
        name: 'get_current_datetime',
        description: 'Get current date/time in the user\'s configured timezone. Call when you need to resolve relative times before setting a reminder.',
        parameters: { type: 'object', properties: {} }
    },
    {
        name: 'get_weather',
        description: 'Get current weather for a location. Default is Redmond, WA. Only call when the user explicitly asks about current weather conditions.',
        parameters: {
            type: 'object',
            properties: {
                latitude: { type: 'number', description: 'Latitude (default 47.674 for Redmond)' },
                longitude: { type: 'number', description: 'Longitude (default -122.121 for Redmond)' }
            }
        }
    }
];

async function executeTool(name, args) {
    switch (name) {
        case 'get_current_datetime': {
            const now = new Date();
            // Compute the actual UTC offset for the configured timezone
            const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
            const tzStr  = now.toLocaleString('en-US', { timeZone: TZ });
            const offsetMs = new Date(tzStr) - new Date(utcStr);
            const offsetMin = Math.round(offsetMs / 60000);
            const sign = offsetMin >= 0 ? '+' : '-';
            const absH = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, '0');
            const absM = String(Math.abs(offsetMin) % 60).padStart(2, '0');
            const offsetStr = `${sign}${absH}:${absM}`;

            return JSON.stringify({
                formatted: now.toLocaleString('en-US', { timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }),
                iso: now.toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T') + offsetStr,
                timezone: TZ
            });
        }
        case 'get_weather': {
            try {
                const w = await getWeather(args.latitude || 47.674, args.longitude || -122.121);
                return JSON.stringify(w);
            } catch (e) { return JSON.stringify({ error: e.message }); }
        }
        case 'set_reminder': {
            const todo = addTodo(args.title, args.due_date, args.due_time, 'reminder', args.emoji || '🔔');
            setReminder(todo.id, args.remind_at);
            return JSON.stringify({ success: true, todo, message: `Reminder set for ${args.remind_at}` });
        }
        case 'mark_complete': {
            const t = todos.find(t => t.id === args.todo_id);
            if (t) {
                if (!t.completed) todoGauge.add(-1, { source: t.source || 'manual' });
                t.completed = true;
                dbUpdateTodo(t);
                return JSON.stringify({ success: true, todo: t });
            }
            return JSON.stringify({ success: false, error: 'Not found' });
        }
        case 'mark_incomplete': {
            const t = todos.find(t => t.id === args.todo_id);
            if (t) {
                if (t.completed) todoGauge.add(1, { source: t.source || 'manual' });
                t.completed = false;
                dbUpdateTodo(t);
                return JSON.stringify({ success: true, todo: t });
            }
            return JSON.stringify({ success: false, error: 'Not found' });
        }
        case 'add_task': {
            const todo = addTodo(args.title, args.due_date, args.due_time, 'command', args.emoji, args.priority, args.notes, args.tags);
            return JSON.stringify({ success: true, todo });
        }
        case 'remove_task': {
            const idx = todos.findIndex(t => t.id === args.todo_id);
            if (idx >= 0) {
                const [removed] = todos.splice(idx, 1);
                dbDeleteTodo(removed.id);
                if (!removed.completed) todoGauge.add(-1, { source: removed.source || 'manual' });
                return JSON.stringify({ success: true, removed });
            }
            return JSON.stringify({ success: false, error: 'Not found' });
        }
        case 'update_task': {
            const t = todos.find(t => t.id === args.todo_id);
            if (!t) return JSON.stringify({ success: false, error: 'Not found' });
            const validPriorities = ['high', 'medium', 'low', 'none'];
            if (args.title !== undefined) t.title = args.title;
            if (args.due_date !== undefined) t.dueDate = args.due_date === 'clear' ? null : args.due_date;
            if (args.due_time !== undefined) t.dueTime = args.due_time === 'clear' ? null : args.due_time;
            if (args.priority !== undefined && validPriorities.includes(args.priority)) t.priority = args.priority;
            if (args.notes !== undefined) t.notes = args.notes === 'clear' ? null : String(args.notes).slice(0, 5000);
            if (args.tags !== undefined) t.tags = [...new Set((args.tags || []).slice(0, 10))];
            if (args.emoji !== undefined) t.emoji = args.emoji;
            dbUpdateTodo(t);
            return JSON.stringify({ success: true, todo: t });
        }
        case 'create_recurring_reminder': {
            const title = args.title;
            const intervalMin = Math.min(Math.max(parseInt(args.interval_min) || 30, 1), 1440);
            const emoji = args.emoji || '🔁';
            const description = args.description || '';

            // Check duplicate
            const existing = recurringTemplates.find(r => r.title === title);
            if (existing) {
                if (!existing.active) { existing.active = true; }
                existing.intervalMin = intervalMin;
                existing.intervalMs = intervalMin * 60_000;
                dbUpdateTemplate(existing);
                return JSON.stringify({ success: true, recurring: existing, message: `Updated existing recurring reminder "${title}" to every ${intervalMin} min` });
            }

            const rec = {
                id: randomUUID(),
                title,
                emoji,
                description,
                intervalMin,
                intervalMs: intervalMin * 60_000,
                active: true,
                lastFired: Date.now(),
                custom: true
            };
            recurringTemplates.push(rec);
            dbInsertTemplate(rec);
            return JSON.stringify({ success: true, recurring: rec, message: `Created recurring reminder "${title}" every ${intervalMin} min` });
        }
        default:
            return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// MarkItDown MCP client
// ════════════════════════════════════════════════════════════════════════════

let mcpClient = null;

async function initMcp() {
    try {
        const pyPath = process.platform === 'win32'
            ? path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'Scripts', 'markitdown-mcp.exe')
            : 'markitdown-mcp';
        const cmd = fs.existsSync(pyPath) ? pyPath : 'markitdown-mcp';
        const transport = new StdioClientTransport({ command: cmd });
        mcpClient = new Client({ name: 'taskbean', version: '1.0.0' });
        await mcpClient.connect(transport);
        console.log('✅ MarkItDown MCP connected');
    } catch (err) {
        console.warn(`⚠️  MarkItDown MCP not available (${err.message})`);
        console.warn('   Install: pip install markitdown-mcp');
    }
}

async function convertFile(filePath) {
    return tracer.startActiveSpan('mcp.convertFile', async (span) => {
        try {
            if (!mcpClient) throw new Error('MarkItDown not available — pip install markitdown-mcp');
            span.setAttribute('file.path', filePath);
            const uri = `file:///${filePath.replace(/\\/g, '/')}`;
            const result = await mcpClient.callTool({ name: 'convert_to_markdown', arguments: { uri } });
            if (result.content?.length > 0) {
                const text = result.content.map(c => c.text || '').join('\n');
                span.setAttribute('result.length', text.length);
                span.setStatus({ code: SpanStatusCode.OK });
                return text;
            }
            throw new Error('MarkItDown returned empty result');
        } catch (err) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            span.recordException(err);
            throw err;
        } finally {
            span.end();
        }
    });
}

// ════════════════════════════════════════════════════════════════════════════
// Foundry Local SDK — model catalog, cache, download, load, inference
// ════════════════════════════════════════════════════════════════════════════

import { execSync, exec } from 'child_process';

let FOUNDRY_URL = '';
let foundryReady = false;
let modelReady = false;
let startupError = null;

// ════════════════════════════════════════════════════════════════════════════
// Model catalog via Foundry Local SDK
// ════════════════════════════════════════════════════════════════════════════

/** Lazy-init the SDK singleton. Reused across requests. */
let _flManager = null;
function getFoundryManager() {
    if (!_flManager) {
        // Let the SDK auto-discover the native core DLL.
        // The foundry-local-sdk-winml install script places the WinML variant
        // in the standard @foundry-local-core/win32-x64 directory.
        _flManager = FoundryLocalManager.create({ appName: 'taskbean' });
    }
    return _flManager;
}

// resolveNativeCorePath removed — SDK auto-discovery works correctly
// and avoids breaking EP bootstrapper registration.

/**
 * Build a flat model catalog from the SDK.
 * Each variant becomes its own entry with alias, modelId, device, cached, etc.
 */
async function getModelCatalogFromSDK() {
    const mgr = getFoundryManager();
    const models = await mgr.catalog.getModels();

    // Fetch cached model IDs once upfront instead of calling v.isCached per-variant
    // (which makes N synchronous native calls). One getCachedModels() call is sufficient.
    let cachedIds = new Set();
    try {
        const cachedVariants = await mgr.catalog.getCachedModels();
        cachedIds = new Set(cachedVariants.map(cv => cv.id));
    } catch {}

    const catalog = [];
    for (const model of models) {
        for (const v of model.variants) {
            const info = v.info;
            const deviceType = info.runtime?.deviceType || '';
            const deviceNorm = deviceType.toUpperCase().includes('NPU') ? 'NPU'
                             : deviceType.toUpperCase().includes('GPU') ? 'GPU'
                             : deviceType.toUpperCase().includes('CPU') ? 'CPU'
                             : deviceType || 'Unknown';

            const aliasLower = (info.alias || '').toLowerCase();
            const family = aliasLower.startsWith('qwen')     ? 'Qwen'
                         : aliasLower.startsWith('phi')      ? 'Phi'
                         : aliasLower.startsWith('deepseek') ? 'DeepSeek'
                         : aliasLower.startsWith('mistral')  ? 'Mistral'
                         : aliasLower.startsWith('gpt')      ? 'GPT'
                         : aliasLower.startsWith('llama')    ? 'Llama'
                         : aliasLower.startsWith('gemma')    ? 'Gemma'
                         : 'Other';

            const paramMatch = (info.alias || '').match(/[_-](\d+\.?\d*)\s*b\b/i);
            const paramBillions = paramMatch ? parseFloat(paramMatch[1]) : null;

            const tasks = [];
            if (info.task?.includes('chat')) tasks.push('chat');
            if (v.supportsToolCalling) tasks.push('tools');

            catalog.push({
                alias:         info.alias || model.alias,
                modelId:       v.id,
                device:        deviceNorm,
                fileSizeGb:    info.fileSizeMb ? +(info.fileSizeMb / 1024).toFixed(2) : null,
                paramBillions,
                family,
                tasks,
                license:       info.license || '',
                cached:        cachedIds.has(v.id),
                cachePath:     cachedIds.has(v.id) ? (() => { try { return v.path; } catch { return null; } })() : null,
                contextLength: info.contextLength ?? null,
                maxOutputTokens: info.maxOutputTokens ?? null,
            });
        }
    }

    // Check for available updates on cached models
    for (const entry of catalog) {
        if (!cachedIds.has(entry.modelId)) continue;
        try {
            const variant = mgr.catalog.modelIdToModelVariant.get(entry.modelId);
            if (!variant) continue;
            const latest = await mgr.catalog.getLatestVersion(variant);
            if (latest.id !== variant.id) {
                entry.updateAvailable = true;
                entry.latestModelId = latest.id;
            }
        } catch {} // skip version check failures silently
    }

    return catalog;
}

/** Cache the catalog for ~60 sto avoid rebuilding on every request */
let _modelCatalogCache = null;
let _modelCatalogExpiry = 0;
async function getModelCatalog() {
    if (_modelCatalogCache && Date.now() < _modelCatalogExpiry) return _modelCatalogCache;
    _modelCatalogCache = await getModelCatalogFromSDK();
    _modelCatalogExpiry = Date.now() + 60_000;
    return _modelCatalogCache;
}

async function ensureFoundryService() {
    const mgr = getFoundryManager();

    // Register execution providers (NPU/GPU acceleration) — non-blocking if it fails
    try {
        const epResult = await mgr.downloadAndRegisterEps((epName, pct) => {
            process.stdout.write(`\r   EP ${epName}: ${pct.toFixed(0)}%`);
        });
        if (epResult.registeredEps?.length > 0) {
            console.log(`\n✅ Registered EPs: ${epResult.registeredEps.join(', ')}`);
            // Invalidate the server-level model catalog cache so NPU models appear
            _modelCatalogCache = null;
            _modelCatalogExpiry = 0;
        }
    } catch (err) {
        console.warn('⚠ EP registration failed (CPU models still available):', err.message);
    }

    // Start the SDK's embedded web service (OpenAI-compatible inference endpoint)
    if (!mgr.isWebServiceRunning) {
        try {
            mgr.startWebService();
        } catch (err) {
            throw new Error(`Failed to start embedded web service: ${err.message}`);
        }
    }
    if (!mgr.urls?.length) {
        throw new Error('Web service started but no URLs were bound');
    }
    FOUNDRY_URL = mgr.urls[0];
}

async function ensureModelLoaded() {
    // Check if model is already loaded via the embedded web service
    try {
        const res = await fetch(`${FOUNDRY_URL}/v1/models`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
            const data = await res.json();
            const loaded = data.data?.find(m => m.id === MODEL_ID || m.parent === MODEL_ID.split(':')[0]);
            if (loaded) { console.log(`✅ Model ${loaded.id} already loaded`); return; }
        }
    } catch {}

    // Download (if needed) and load via SDK
    console.log(`\n📦 Loading model: ${MODEL_ID}...`);
    const mgr = getFoundryManager();

    let variant;
    try {
        variant = await mgr.catalog.getModelVariant(MODEL_ID);
    } catch (err) {
        throw new Error(`Model "${MODEL_ID}" not found in catalog: ${err.message}`);
    }

    if (!variant.isCached) {
        console.log(`   Downloading ${MODEL_ID}…`);
        await variant.download((pct) => {
            process.stdout.write(`\r   Downloading… ${pct.toFixed(1)}%`);
        });
        console.log('');
    }

    await variant.load();
}

async function verifyModelResponds() {
    console.log('🔍 Verifying model responds...');
    // Use stream: true — NPU models return HTTP 500 on non-streaming requests
    const body = JSON.stringify({ model: MODEL_ID, messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 5 });
    for (let i = 0; i < 3; i++) {
        try {
            const res = await fetch(`${FOUNDRY_URL}/v1/chat/completions`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body, signal: AbortSignal.timeout(60_000)
            });
            if (res.ok) {
                // Drain the stream so the connection closes cleanly
                await res.body?.cancel();
                console.log('✅ Model verified — responding to requests');
                return;
            }
        } catch {}
        console.log(`   Retry ${i + 1}/3...`);
        await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error('Model loaded but not responding. Check foundry service logs.');
}

// With the embedded SDK web service, the URL is stable — no refresh needed.
function refreshFoundryUrl() {}

async function initializeFoundry() {
    startupError = null;
    modelReady = false;
    foundryReady = false;
    try {
        await ensureFoundryService();
        foundryReady = true;
        console.log(`🚀 Foundry Local service at ${FOUNDRY_URL}`);
        await ensureModelLoaded();
        await verifyModelResponds();
        modelReady = true;
        console.log('✅ Model ready');
    } catch (err) {
        startupError = err.message;
        console.warn(`⚠️  Foundry startup incomplete: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Inference Router — SDK ChatClient + ResponsesClient with model compatibility
// ════════════════════════════════════════════════════════════════════════════

function normalizeNativeTools(tools) {
    return tools.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
        }
    }));
}

function getAssistantText(chatData) {
    const message = chatData?.choices?.[0]?.message;
    if (!message) return '';
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
        return message.content
            .filter(part => part.type === 'text' || part.type === 'output_text')
            .map(part => part.text || '')
            .join('');
    }
    return '';
}

/** Determine the active model's capabilities for inference routing. */
function getModelCapabilities() {
    const catalog = _modelCatalogCache || [];
    const entry = catalog.find(m => m.modelId === MODEL_ID);
    if (!entry) {
        // Catalog not loaded yet — use conservative defaults based on MODEL_ID heuristics
        const idLower = MODEL_ID.toLowerCase();
        const isNpu = idLower.includes('npu') || idLower.includes('vitis');
        return {
            supportsTools: false, // conservative — don't send tools without catalog confirmation
            requiresStreamOnly: isNpu,
            toolChoiceMode: 'none',
            device: isNpu ? 'NPU' : idLower.includes('gpu') ? 'GPU' : 'CPU',
        };
    }
    const device = entry.device || 'CPU';
    const supportsTools = entry.tasks?.includes('tools') ?? false;
    return {
        supportsTools,
        requiresStreamOnly: device === 'NPU',
        toolChoiceMode: supportsTools ? 'auto' : 'none',
        device,
    };
}

// ── SDK client cache ────────────────────────────────────────────────────────
let _chatClient = null;
let _chatClientModelId = null;
let _responsesClient = null;
let _responsesClientModelId = null;

function getChatClient() {
    if (_chatClient && _chatClientModelId === MODEL_ID) return _chatClient;
    const mgr = getFoundryManager();
    const variant = mgr.catalog.modelIdToModelVariant.get(MODEL_ID);
    if (!variant) throw new Error(`Model ${MODEL_ID} not in catalog — restart server or switch models`);
    _chatClient = variant.createChatClient();
    _chatClientModelId = MODEL_ID;
    return _chatClient;
}

function getResponsesClient() {
    if (_responsesClient && _responsesClientModelId === MODEL_ID) return _responsesClient;
    _responsesClient = new ResponsesClient(FOUNDRY_URL, MODEL_ID);
    _responsesClientModelId = MODEL_ID;
    return _responsesClient;
}

// ── Parallel tool calls preference + failure tracking ───────────────────────
let _parallelToolCallFailures = 0;
const PARALLEL_TOOL_FAIL_THRESHOLD = 2; // suggest disabling after N failures

function getParallelToolCallsSetting() {
    const pref = serverConfig.parallelToolCalls ?? 'auto';
    if (pref === 'on') return true;
    if (pref === 'off') return false;
    // Auto: enable unless we've seen repeated failures
    if (_parallelToolCallFailures >= PARALLEL_TOOL_FAIL_THRESHOLD) return false;
    // Disable for NPU models (known to struggle with parallel inference)
    const caps = getModelCapabilities();
    if (caps.device === 'NPU') return false;
    return true;
}

function recordParallelToolCallFailure() {
    _parallelToolCallFailures++;
    const currentSpan = trace.getActiveSpan();
    if (currentSpan) currentSpan.addEvent('inference.parallel_tool_call_failure', {
        'ai.model': MODEL_ID,
        'failure_count': _parallelToolCallFailures,
        'threshold': PARALLEL_TOOL_FAIL_THRESHOLD,
    });
}

function resetParallelToolCallFailures() {
    _parallelToolCallFailures = 0;
}

/** Determine which inference client to use. */
function getPreferredClient() {
    const pref = serverConfig.inferenceClient || 'auto';
    if (pref === 'responses') return 'responses';
    if (pref === 'chat') return 'chat';
    // Auto: prefer ChatClient (native FFI, faster) for everything
    return 'chat';
}

// ── Structured prompt fallback for non-tool models ──────────────────────────

function buildStructuredPromptFallback(instructions, userMessage, tools) {
    const toolDescriptions = tools.map(t => {
        const fn = t.function || t;
        const params = fn.parameters?.properties
            ? Object.entries(fn.parameters.properties).map(([k, v]) => `${k}: ${v.type}${v.description ? ' — ' + v.description : ''}`).join(', ')
            : '';
        return `- ${fn.name}: ${fn.description}${params ? ` (params: ${params})` : ''}`;
    }).join('\n');

    const fallbackInstructions = `${instructions || ''}

You have these actions available:
${toolDescriptions}

When you want to perform an action, respond with EXACTLY this JSON format on a single line:
{"action": "<tool_name>", "params": {<parameters>}}

If you want to respond with plain text (no action), just write your response normally.
Do NOT wrap JSON in code blocks. Output the JSON directly.`.trim();

    return [
        { role: 'system', content: fallbackInstructions },
        { role: 'user', content: userMessage }
    ];
}

function parseStructuredFallbackResponse(text) {
    const trimmed = text.trim();
    // First: try parsing the entire response as JSON
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed.action && typeof parsed.action === 'string') {
            // Validate tool name against known tools
            const validTools = new Set(NL_TOOLS.map(t => t.name));
            if (validTools.has(parsed.action)) {
                return { action: parsed.action, params: parsed.params || {} };
            }
        }
    } catch {}

    // Fallback: try to extract JSON from the response (for models that add prose)
    // Use balanced brace matching instead of fragile regex
    const start = trimmed.indexOf('{"action"');
    if (start === -1) return null;
    let depth = 0;
    let end = -1;
    for (let i = start; i < trimmed.length; i++) {
        if (trimmed[i] === '{') depth++;
        else if (trimmed[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end === -1) return null;

    try {
        const parsed = JSON.parse(trimmed.slice(start, end));
        if (parsed.action && typeof parsed.action === 'string') {
            const validTools = new Set(NL_TOOLS.map(t => t.name));
            if (validTools.has(parsed.action)) {
                return { action: parsed.action, params: parsed.params || {} };
            }
        }
    } catch {}
    return null;
}

// Strip reasoning tags (<think>...</think>) from model output
function stripReasoningTags(text) {
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Strip leaked Qwen 2.5 tool-call special tokens from text responses
function cleanModelOutput(text) {
    return stripReasoningTags(
        text.replace(/<\|tool_call\|>[\s\S]*?<\|\/tool_call\|>/g, '').trim()
    );
}

// ── aiComplete: non-streaming, used by suggest/extract/speech ───────────────

async function aiComplete(instructions, userMessage) {
    return tracer.startActiveSpan('ai.complete', async (span) => {
        const start = Date.now();
        span.setAttribute('ai.model', MODEL_ID);
        span.setAttribute('ai.prompt_length', (instructions?.length || 0) + userMessage.length);
        aiCallCounter.add(1, { model: MODEL_ID });
        incMetric('aiCalls');

        try {
            const messages = [];
            if (instructions) messages.push({ role: 'system', content: instructions });
            messages.push({ role: 'user', content: userMessage });

            const client = getPreferredClient();
            let content;
            let tokensIn, tokensOut;

            const caps = getModelCapabilities();

            if (client === 'responses') {
                const rc = getResponsesClient();
                // Reset ALL settings to safe defaults before each use
                rc.settings.temperature = 0.7;
                rc.settings.maxOutputTokens = 2000;
                rc.settings.instructions = instructions || undefined;
                rc.settings.parallelToolCalls = getParallelToolCallsSetting();
                rc.settings.toolChoice = undefined;
                rc.settings.truncation = undefined;
                rc.settings.reasoning = undefined;
                rc.settings.text = undefined;
                rc.settings.seed = undefined;
                const response = await rc.create(userMessage);
                content = getOutputText(response);
                tokensIn = response?.usage?.input_tokens ?? response?.usage?.prompt_tokens;
                tokensOut = response?.usage?.output_tokens ?? response?.usage?.completion_tokens;
            } else {
                const cc = getChatClient();
                // Reset ALL settings to safe defaults before each use
                cc.settings.temperature = 0.7;
                cc.settings.maxTokens = 2000;
                cc.settings.topP = undefined;
                cc.settings.topK = undefined;
                cc.settings.frequencyPenalty = undefined;
                cc.settings.presencePenalty = undefined;
                cc.settings.responseFormat = undefined;
                cc.settings.toolChoice = undefined;

                if (caps.requiresStreamOnly) {
                    // NPU models crash on non-streaming requests
                    let accumulated = '';
                    for await (const chunk of cc.completeStreamingChat(messages)) {
                        const delta = chunk.choices?.[0]?.delta?.content;
                        if (delta) accumulated += delta;
                        // OpenAI streaming: last chunk carries usage when stream_options.include_usage is set,
                        // or Foundry Local may include it by default
                        if (chunk.usage) {
                            tokensIn = chunk.usage.prompt_tokens;
                            tokensOut = chunk.usage.completion_tokens;
                        }
                    }
                    content = accumulated;
                } else {
                    const response = await cc.completeChat(messages);
                    content = getAssistantText(response);
                    tokensIn = response?.usage?.prompt_tokens;
                    tokensOut = response?.usage?.completion_tokens;
                }
            }

            content = cleanModelOutput(content);
            const elapsed = Date.now() - start;

            span.setAttribute('ai.response_length', content.length);
            span.setAttribute('ai.latency_ms', elapsed);
            span.setAttribute('ai.client', client);
            if (tokensIn != null) span.setAttribute('gen_ai.usage.input_tokens', tokensIn);
            if (tokensOut != null) span.setAttribute('gen_ai.usage.output_tokens', tokensOut);
            aiLatency.record(elapsed, { model: MODEL_ID });
            span.setStatus({ code: SpanStatusCode.OK });
            return content;
        } catch (err) {
            aiErrorCounter.add(1, { model: MODEL_ID, error: err.message.slice(0, 100) });
            incMetric('errors');
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            span.recordException(err);
            throw err;
        } finally {
            span.end();
        }
    });
}

// ── aiCompleteWithNativeTools: streaming + tool calling, used by /api/command ─

async function aiCompleteWithNativeTools(instructions, userMessage) {
    return tracer.startActiveSpan('ai.completeWithTools', async (span) => {
        const start = Date.now();
        const caps = getModelCapabilities();
        const client = getPreferredClient();
        span.setAttribute('ai.model', MODEL_ID);
        span.setAttribute('ai.mode', 'tool-calling');
        span.setAttribute('ai.client', client);
        span.setAttribute('ai.supports_tools', caps.supportsTools);
        span.setAttribute('ai.prompt_length', (instructions?.length || 0) + userMessage.length);
        aiCallCounter.add(1, { model: MODEL_ID, mode: 'command' });
        incMetric('aiCalls');

        const tools = normalizeNativeTools(NL_TOOLS);
        const messages = [];
        if (instructions) messages.push({ role: 'system', content: instructions });
        messages.push({ role: 'user', content: userMessage });

        const toolExecutions = [];

        try {
            // If model doesn't support tool calling, use structured prompt fallback
            if (!caps.supportsTools) {
                const fallbackMessages = buildStructuredPromptFallback(instructions, userMessage, tools);
                const cc = getChatClient();
                // Reset ALL settings to safe defaults before each use
                cc.settings.temperature = 0.7;
                cc.settings.maxTokens = 1200;
                cc.settings.topP = undefined;
                cc.settings.topK = undefined;
                cc.settings.frequencyPenalty = undefined;
                cc.settings.presencePenalty = undefined;
                cc.settings.responseFormat = undefined;
                cc.settings.toolChoice = undefined;

                let response;
                if (caps.requiresStreamOnly) {
                    // NPU models crash on non-streaming requests — accumulate stream
                    let accumulated = '';
                    for await (const chunk of cc.completeStreamingChat(fallbackMessages)) {
                        if (chunk.usage) {
                            span.setAttribute('gen_ai.usage.input_tokens', chunk.usage.prompt_tokens);
                            span.setAttribute('gen_ai.usage.output_tokens', chunk.usage.completion_tokens);
                        }
                        const delta = chunk.choices?.[0]?.delta?.content;
                        if (delta) accumulated += delta;
                    }
                    response = { choices: [{ message: { content: accumulated } }] };
                } else {
                    response = await cc.completeChat(fallbackMessages);
                    if (response?.usage) {
                        span.setAttribute('gen_ai.usage.input_tokens', response.usage.prompt_tokens);
                        span.setAttribute('gen_ai.usage.output_tokens', response.usage.completion_tokens);
                    }
                }
                const text = cleanModelOutput(getAssistantText(response));

                const parsed = parseStructuredFallbackResponse(text);
                if (parsed) {
                    const toolStart = Date.now();
                    const result = await executeTool(parsed.action, parsed.params);
                    span.addEvent('tool.executed', { 'tool.name': parsed.action, 'tool.args': JSON.stringify(parsed.params), 'tool.result': result.slice(0, 200), durationMs: Date.now() - toolStart });
                    toolExecutions.push({ name: parsed.action, args: parsed.params, result });
                }

                const elapsed = Date.now() - start;
                aiLatency.record(elapsed, { model: MODEL_ID, mode: 'command' });
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                return { reply: parsed ? '' : text, toolExecutions };
            }

            // ── ResponsesClient path (HTTP, supports parallelToolCalls) ──
            if (client === 'responses') {
                const rc = getResponsesClient();
                // Reset ALL settings to safe defaults before each use
                rc.settings.temperature = 0.7;
                rc.settings.maxOutputTokens = 1200;
                rc.settings.instructions = instructions || undefined;
                const parallelEnabled = getParallelToolCallsSetting();
                rc.settings.parallelToolCalls = parallelEnabled;
                rc.settings.toolChoice = undefined;
                rc.settings.truncation = undefined;
                rc.settings.reasoning = undefined;
                rc.settings.text = undefined;
                rc.settings.seed = undefined;
                span.setAttribute('ai.parallel_tool_calls', parallelEnabled);

                // ResponsesClient tools use flatter format: { type, name, description, parameters }
                const responsesTools = NL_TOOLS.map(t => ({
                    type: 'function',
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                }));

                try {
                    // Multi-turn tool loop (matches ChatClient's 4-round loop)
                    let input = userMessage;
                    for (let round = 0; round < 4; round++) {
                        const response = await rc.create(input, { tools: responsesTools });

                        // Check for function calls in output
                        const functionCalls = (response.output || []).filter(item => item.type === 'function_call');
                        if (!functionCalls.length) {
                            // No more tool calls — extract final reply
                            const reply = cleanModelOutput(getOutputText(response));
                            resetParallelToolCallFailures();

                            const elapsed = Date.now() - start;
                            aiLatency.record(elapsed, { model: MODEL_ID, mode: 'command' });
                            span.setStatus({ code: SpanStatusCode.OK });
                            span.setStatus({ code: SpanStatusCode.OK });
                            span.end();
                            return { reply, toolExecutions };
                        }

                        // Execute tools and build continuation input
                        const toolOutputs = [];
                        for (const fc of functionCalls) {
                            let args = {};
                            try { args = JSON.parse(fc.arguments || '{}'); } catch {}
                            const toolStart = Date.now();
                            const result = await executeTool(fc.name, args);
                            span.addEvent('tool.executed', { 'tool.name': fc.name, 'tool.args': JSON.stringify(args), 'tool.result': result.slice(0, 200), durationMs: Date.now() - toolStart });
                            toolExecutions.push({ name: fc.name, args, result });
                            toolOutputs.push({
                                type: 'function_call_output',
                                call_id: fc.call_id || fc.id,
                                output: result,
                            });
                        }

                        // Continue with tool outputs
                        input = toolOutputs;
                    }

                    // Exhausted rounds
                    resetParallelToolCallFailures();
                    const elapsed = Date.now() - start;
                    aiLatency.record(elapsed, { model: MODEL_ID, mode: 'command' });
                    span.setStatus({ code: SpanStatusCode.OK });
                    span.setStatus({ code: SpanStatusCode.OK });
                    span.end();
                    return { reply: 'I used the available tools but could not finish the response cleanly.', toolExecutions };
                } catch (rcErr) {
                    // If parallel tool calls caused the failure, record it
                    if (parallelEnabled) {
                        recordParallelToolCallFailure();
                        span.addEvent('inference.suggestion', {
                            subtype: 'disable_parallel_tool_calls',
                            reason: rcErr.message,
                            'failure_count': _parallelToolCallFailures,
                        });
                    }
                    throw rcErr;
                }
            }

            // ── ChatClient path (native FFI, multi-round streaming) ──
            const cc = getChatClient();
            // Reset ALL settings to safe defaults before each use
            cc.settings.temperature = 0.7;
            cc.settings.maxTokens = 1200;
            cc.settings.topP = undefined;
            cc.settings.topK = undefined;
            cc.settings.frequencyPenalty = undefined;
            cc.settings.presencePenalty = undefined;
            cc.settings.responseFormat = undefined;
            cc.settings.toolChoice = undefined;

            for (let round = 0; round < 4; round++) {
                let textContent = '';
                const toolCallMap = {};

                for await (const chunk of cc.completeStreamingChat(
                    messages,
                    caps.toolChoiceMode !== 'none' ? tools : undefined
                )) {
                    // Capture usage from streaming chunks
                    if (chunk.usage) {
                        span.setAttribute('gen_ai.usage.input_tokens', chunk.usage.prompt_tokens ?? chunk.usage.input_tokens);
                        span.setAttribute('gen_ai.usage.output_tokens', chunk.usage.completion_tokens ?? chunk.usage.output_tokens);
                    }
                    // Also check finish_reason
                    if (chunk.choices?.[0]?.finish_reason) {
                        span.setAttribute('gen_ai.response.finish_reason', chunk.choices[0].finish_reason);
                    }
                    const delta = chunk.choices?.[0]?.delta;
                    if (!delta) continue;

                    if (delta.content) textContent += delta.content;

                    if (Array.isArray(delta.tool_calls)) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (!toolCallMap[idx]) {
                                toolCallMap[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                            }
                            if (tc.id) toolCallMap[idx].id = tc.id;
                            if (tc.function?.name) toolCallMap[idx].function.name += tc.function.name;
                            if (tc.function?.arguments) toolCallMap[idx].function.arguments += tc.function.arguments;
                        }
                    }
                }

                const toolCalls = Object.values(toolCallMap).filter(tc => tc.function.name);
                if (!toolCalls.length) {
                    const cleanText = cleanModelOutput(textContent);
                    const elapsed = Date.now() - start;
                    aiLatency.record(elapsed, { model: MODEL_ID, mode: 'command' });
                    span.setStatus({ code: SpanStatusCode.OK });
                    span.setStatus({ code: SpanStatusCode.OK });
                    span.end();
                    return { reply: cleanText || textContent, toolExecutions };
                }

                messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });

                for (const toolCall of toolCalls) {
                    const toolName = toolCall.function.name;
                    let args = {};
                    let result;

                    try {
                        args = JSON.parse(toolCall.function.arguments || '{}');
                    } catch {
                        result = JSON.stringify({ success: false, error: `Invalid JSON arguments for ${toolName}` });
                    }

                    const toolStart = Date.now();
                    if (!result) result = await executeTool(toolName, args);

                    span.addEvent('tool.executed', { 'tool.name': toolName, 'tool.args': JSON.stringify(args), 'tool.result': result.slice(0, 200), durationMs: Date.now() - toolStart });
                    toolExecutions.push({ name: toolName, args, result });
                    messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });

                    if (!INFORMATIONAL_TOOLS.has(toolName)) /* mutationExecuted = true */;
                }
            }

            aiLatency.record(Date.now() - start, { model: MODEL_ID, mode: 'command' });
            span.setStatus({ code: SpanStatusCode.OK });
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return {
                reply: 'I used the available tools but could not finish the response cleanly.',
                toolExecutions
            };
        } catch (err) {
            aiErrorCounter.add(1, { model: MODEL_ID, mode: 'command', error: err.message.slice(0, 100) });
            incMetric('errors');
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            span.recordException(err);
            span.end();
            throw err;
        }
    });
}

// Invalidate cached clients when model changes
function invalidateInferenceClients() {
    _chatClient = null;
    _chatClientModelId = null;
    _responsesClient = null;
    _responsesClientModelId = null;
    resetParallelToolCallFailures();
}

await initMcp();
initializeFoundry();

// ════════════════════════════════════════════════════════════════════════════
// Express app
// ════════════════════════════════════════════════════════════════════════════

const app = express();
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'", "https://unpkg.com", "https://api.open-meteo.com", "http://localhost:*"],
            frameSrc: ["'self'", "http://localhost:*"],
            frameAncestors: ["'none'"],
            upgradeInsecureRequests: null,
        }
    },
    hsts: false,
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(os.tmpdir(), 'taskbean-uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const uploadAudio = multer({
    dest: uploadDir,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
    fileFilter: (_req, file, cb) => {
        if (file.mimetype.startsWith('audio/') || file.mimetype === 'application/octet-stream') {
            cb(null, true);
        } else {
            cb(new Error('Only audio files are accepted'));
        }
    }
});

const uploadDoc = multer({
    dest: uploadDir,
    limits: { fileSize: 50 * 1024 * 1024 },
});

// Clean stale upload temp files on startup
try {
    for (const f of fs.readdirSync(uploadDir)) {
        const fp = path.join(uploadDir, f);
        const stat = fs.statSync(fp);
        if (Date.now() - stat.mtimeMs > 3600_000) fs.unlinkSync(fp); // older than 1 hour
    }
} catch {}

app.get('/api/health', (_req, res) => {
    const catalog = _modelCatalogCache || [];
    const entry = catalog.find(m => m.modelId === MODEL_ID);
    res.json({
        status: 'ok',
        model: MODEL_ID,
        modelAlias: entry?.alias || null,
        foundryUrl: FOUNDRY_URL,
        foundryReady,
        modelReady,
        startupError,
        mcpAvailable: !!mcpClient,
        inference: {
            client: getPreferredClient(),
            parallelToolCalls: getParallelToolCallsSetting(),
            parallelToolCallFailures: _parallelToolCallFailures,
            modelCapabilities: getModelCapabilities(),
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// User preferences / config
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/config', (_req, res) => {
    res.json({ ...serverConfig, timezone: TZ, hardware: getHardwareSnapshot() });
});

app.post('/api/config', (req, res) => {
    const body = req.body || {};
    for (const [key, value] of Object.entries(body)) {
        if (key === 'timezone') {
            // Validate that the timezone is a real IANA timezone
            try {
                Intl.DateTimeFormat(undefined, { timeZone: value });
                TZ = value;
            } catch {
                return res.status(400).json({ error: `Invalid timezone: ${value}` });
            }
        }
        // Merge schedule sub-keys instead of overwriting the whole object
        if (key === 'schedule' && typeof value === 'object') {
            serverConfig.schedule = { ...(serverConfig.schedule || {}), ...value };
        } else {
            serverConfig[key] = value;
        }
    }
    saveServerConfig(serverConfig);
    res.json({ ...serverConfig, timezone: TZ, hardware: getHardwareSnapshot() });
});

app.get('/api/hardware', (_req, res) => {
    res.json(getHardwareSnapshot());
});

app.get('/api/hardware/eps', (_req, res) => {
    try {
        const mgr = getFoundryManager();
        const eps = mgr.discoverEps();
        res.json(eps);
    } catch (err) {
        res.json([]);
    }
});

// ════════════════════════════════════════════════════════════════════════════
// Model management API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/models', async (_req, res) => {
    try {
        const catalog = await getModelCatalog();

        // Ask Foundry which models are loaded right now
        let loadedIds = new Set();
        try {
            const r = await fetch(`${FOUNDRY_URL}/v1/models`, { signal: AbortSignal.timeout(5000) });
            if (r.ok) {
                const data = await r.json();
                for (const m of data.data ?? []) {
                    loadedIds.add(m.id);
                    if (m.parent) loadedIds.add(m.parent);
                }
            }
        } catch { /* Foundry may be initializing */ }

        const models = catalog.map(m => ({
            ...m,
            active: m.modelId === MODEL_ID,
            loaded: loadedIds.has(m.modelId) || loadedIds.has(m.modelId.split(':')[0]),
        }));

        res.json({ active: MODEL_ID, models });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Serialize model switch operations to prevent races
let _switchInProgress = false;

app.post('/api/models/switch', async (req, res) => {
    const { modelId, forceDownload } = req.body ?? {};
    if (!modelId) return res.status(400).json({ error: 'modelId required' });
    if (_switchInProgress) return res.status(409).json({ error: 'A model switch is already in progress' });

    const catalog = await getModelCatalog();
    const entry = catalog.find(m => m.modelId === modelId);
    if (!entry) return res.status(404).json({ error: `Model "${modelId}" not found in catalog` });

    _switchInProgress = true;

    // SSE stream so the client sees live progress
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let disconnected = false;
    req.on('close', () => { disconnected = true; });

    const send = (type, payload = {}) => {
        if (!disconnected) res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
    };

    try {
        const mgr = getFoundryManager();
        const variant = await mgr.catalog.getModelVariant(modelId);

        // Download if not cached (or forced)
        if (!variant.isCached || forceDownload) {
            send('progress', { message: `Downloading ${entry.alias} (${entry.fileSizeGb} GB)…` });
            await variant.download((pct) => {
                send('download_progress', { message: `Downloading… ${pct.toFixed(1)}%`, pct });
            });
            send('progress', { message: 'Download complete. Loading model…' });
        } else {
            send('progress', { message: `Loading ${entry.alias} (${entry.fileSizeGb} GB)…` });
        }

        // Load the model via the SDK
        await variant.load();

        // Verify the model is actually serving via the embedded web service
        try {
            const probe = await fetch(`${FOUNDRY_URL}/v1/models`, { signal: AbortSignal.timeout(5000) });
            if (probe.ok) {
                const data = await probe.json();
                const found = data.data?.some(m => m.id === modelId || m.id === modelId.split(':')[0]);
                if (!found) throw new Error('Model loaded but not visible in web service');
            }
        } catch (verifyErr) {
            send('error', { message: `Model loaded but verification failed: ${verifyErr.message}` });
            return;
        }

        // Always persist — model is loaded regardless of client connection
        MODEL_ID = modelId;
        serverConfig.modelId = modelId;
        saveServerConfig(serverConfig);
        _modelCatalogCache = null;
        invalidateInferenceClients();
        // Only notify if client is still connected
        if (!disconnected) {
            send('done', { modelId, alias: entry.alias });
        }
    } catch (err) {
        send('error', { message: err.message });
    } finally {
        _switchInProgress = false;
        res.end();
    }
});

app.delete('/api/models/cache/:modelId', async (req, res) => {
    const modelId = decodeURIComponent(req.params.modelId);
    try {
        const mgr = getFoundryManager();
        const variant = await mgr.catalog.getModelVariant(modelId);
        // Unload first if loaded, then remove from cache
        try { await variant.unload(); } catch {}
        variant.removeFromCache();
        _modelCatalogCache = null;
        res.json({ ok: true, removed: modelId });
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// ── Todo CRUD ──────────────────────────────────────────────────────────────

app.get('/api/todos', (_req, res) => {
    // Read fresh from DB on every request so CLI-written tasks appear immediately
    todos = dbGetAllTodos();
    res.json(todos);
});

app.post('/api/todos', (req, res) => {
    const { title, emoji, dueDate, dueTime, priority, notes, tags } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const todo = addTodo(title, dueDate || null, dueTime || null, 'manual', emoji || null, priority, notes, tags);
    res.status(201).json(todo);
});

app.patch('/api/todos/:id', (req, res) => {
    const todo = todos.find(t => t.id === req.params.id);
    if (!todo) return res.status(404).json({ error: 'Not found' });
    if (req.body.completed !== undefined && req.body.completed !== todo.completed) {
        todoGauge.add(req.body.completed ? -1 : 1, { source: todo.source || 'manual' });
    }
    const validPriorities = ['high', 'medium', 'low', 'none'];
    for (const key of ['completed', 'title', 'dueDate', 'dueTime', 'reminder', 'remindAt', 'reminderFired', 'priority', 'notes', 'tags']) {
        if (req.body[key] !== undefined) {
            let val = req.body[key];
            if (key === 'priority' && !validPriorities.includes(val)) continue;
            if (key === 'notes') val = val === null ? null : String(val).slice(0, 5000);
            if (key === 'tags') val = [...new Set((Array.isArray(val) ? val : []).slice(0, 10))];
            todo[key] = val;
        }
    }
    dbUpdateTodo(todo);
    res.json(todo);
});

app.delete('/api/todos/:id', (req, res) => {
    const idx = todos.findIndex(t => t.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    const [removed] = todos.splice(idx, 1);
    dbDeleteTodo(removed.id);
    if (!removed.completed) todoGauge.add(-1, { source: removed.source || 'manual' });
    res.json({ success: true });
});

// ── Recurring templates ────────────────────────────────────────────────────

app.get('/api/templates', (_req, res) => {
    res.json({ builtIn: BUILT_IN_TEMPLATES, active: recurringTemplates });
});

app.post('/api/templates/activate', (req, res) => {
    // Check built-in templates first
    const tpl = BUILT_IN_TEMPLATES.find(t => t.title === req.body.title);
    if (tpl) {
        const rec = activateRecurringTemplate(tpl);
        return res.json(rec);
    }
    // Check custom (deactivated) recurring templates
    const custom = recurringTemplates.find(r => r.title === req.body.title);
    if (custom) {
        custom.active = true;
        custom.lastFired = Date.now();
        dbUpdateTemplate(custom);
        return res.json(custom);
    }
    return res.status(404).json({ error: 'Template not found' });
});

app.post('/api/templates/deactivate', (req, res) => {
    const rec = deactivateRecurringTemplate(req.body.id);
    if (!rec) return res.status(404).json({ error: 'Not found' });
    res.json(rec);
});

app.post('/api/templates/create', (req, res) => {
    const { title, emoji, intervalMin, description } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    if (!intervalMin || intervalMin < 1) return res.status(400).json({ error: 'intervalMin must be >= 1' });

    // Check for duplicate title
    const existing = recurringTemplates.find(r => r.title === title);
    if (existing) return res.status(409).json({ error: 'A recurring reminder with this title already exists' });

    const rec = {
        id: randomUUID(),
        title: title.slice(0, 100),
        emoji: emoji || '🔁',
        description: (description || '').slice(0, 200),
        intervalMin: Math.min(Math.max(parseInt(intervalMin) || 30, 1), 1440),
        intervalMs: Math.min(Math.max(parseInt(intervalMin) || 30, 1), 1440) * 60_000,
        active: true,
        lastFired: Date.now(),
        custom: true
    };
    recurringTemplates.push(rec);
    dbInsertTemplate(rec);
    res.status(201).json(rec);
});

// ── File upload→ MarkItDown → markdown ────────────────────────────────────

app.post('/api/upload', uploadDoc.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const ext = path.extname(req.file.originalname);
    fileUploadCounter.add(1, { type: ext });
    incMetric('uploads');
    const currentSpan = trace.getActiveSpan();
    if (currentSpan) currentSpan.addEvent('upload', { ext, sizeBytes: req.file.size, filename: req.file.originalname });
    try {
        const md = await convertFile(req.file.path);
        res.json({ markdown: md, filename: req.file.originalname });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        fs.unlink(req.file.path, () => {});
    }
});

// ── Overdue reminders ─────────────────────────────────────────────────────
app.get('/api/todos/overdue', (_req, res) => {
    const now = new Date();
    const overdue = todos.filter(t =>
        t.reminder && t.remindAt && !t.completed && !t.reminderFired &&
        new Date(t.remindAt) < now
    ).map(t => {
        const overdueMs = now - new Date(t.remindAt);
        const mins = Math.floor(overdueMs / 60000);
        const overdueSince = mins < 60 ? `${mins}m ago`
            : mins < 1440 ? `${Math.floor(mins/60)}h ago`
            : `${Math.floor(mins/1440)}d ago`;
        return { ...t, overdueSince };
    });
    res.json(overdue);
});

// ── AI suggestion chips ───────────────────────────────────────────────────
app.post('/api/suggest', async (req, res) => {
    const { context } = req.body || {};
    // context: { trigger, lastTodoTitle, todoCount, pendingCount, timeOfDay, categories }

    if (!modelReady) {
        return res.json({ suggestions: [] });
    }

    const trigger = context?.trigger || 'idle';
    const todoCount = context?.todoCount ?? todos.length;
    const pendingCount = context?.pendingCount ?? todos.filter(t => !t.completed).length;
    const lastTodo = context?.lastTodoTitle || '';
    const timeOfDay = context?.timeOfDay || getTimeOfDay();
    const categories = context?.categories || '';

    const todoList = todos.slice(0, 10).map(t =>
        `- [${t.completed ? 'x' : ' '}] ${t.title}${t.dueDate ? ` (due: ${t.dueDate})` : ''}`
    ).join('\n');

    const activeRecurring = recurringTemplates.filter(r => r.active).map(r =>
        `- ${r.emoji || '🔁'} ${r.title} (every ${r.intervalMin}m)`
    ).join('\n');
    const builtInInactive = BUILT_IN_TEMPLATES.filter(b =>
        !recurringTemplates.some(r => r.title === b.title && r.active)
    ).map(b => `- ${b.emoji} ${b.title} (${b.intervalMin}m) — ${b.description}`).join('\n');

    const sysPrompt = `You generate quick suggestion chips for a todo app. Return ONLY a JSON array of 2-4 suggestions.

Each suggestion: { "label": "emoji + short text (max 4 words)", "message": "the full command to send to the AI assistant" }

Context:
- Trigger: ${trigger}
- Time: ${timeOfDay}
- Total todos: ${todoCount}, Pending: ${pendingCount}
${lastTodo ? `- Last added: "${lastTodo}"` : ''}
${categories ? `- Active categories: ${categories}` : ''}

Current todos:
${todoList || '(empty list)'}

Active recurring reminders:
${activeRecurring || '(none active)'}

Available built-in recurring reminders (not yet enabled):
${builtInInactive || '(all enabled)'}

Rules:
- If trigger is "onboarding" (empty list): suggest getting started (plan my day, add first task, what's the weather)
- If trigger is "thematic" and lastTodo is set: suggest 2-3 related items in the same category
- If trigger is "completion": suggest next actions or celebration
- If trigger is "recurring_recommendations": suggest 2-3 recurring reminders the user should enable or create based on their active ones and todos. Use the message format "set up a recurring reminder every X minutes to Y" for custom ones, or "enable the Z recurring reminder" for built-in ones.
- If trigger is "idle" + morning: suggest planning the day. Include 1 recurring reminder suggestion if they have few active.
- If trigger is "idle" + evening: suggest reviewing what's done
- If trigger is "idle" + general: suggest organizing, adding reminders, or fun tasks. Include 1 recurring reminder suggestion if they have few active.
- Keep labels SHORT (emoji + 2-4 words). Messages should be natural language commands.
- Be creative, helpful, and slightly playful.

Return ONLY the JSON array, no other text.`;

    try {
        const raw = await aiComplete(sysPrompt, `Generate suggestions for trigger="${trigger}"`);

        let suggestions = [];
        try {
            const match = raw.match(/\[[\s\S]*\]/);
            if (match) suggestions = JSON.parse(match[0]);
        } catch {}

        // Validate shape and limit
        suggestions = suggestions
            .filter(s => s.label && s.message)
            .slice(0, 4)
            .map(s => ({
                label: String(s.label).slice(0, 40),
                message: String(s.message).slice(0, 200)
            }));

        res.json({ suggestions });
    } catch (err) {
        res.json({ suggestions: [] });
    }
});

// ── Extract tasks from text ────────────────────────────────────────────────

app.post('/api/extract', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);

    try {
        const added = await tracer.startActiveSpan('extract.tasks', async (extractSpan) => {
            const start = Date.now();
            extractSpan.setAttribute('input.length', text.length);

            const sysPrompt = `You extract tasks from text. Return ONLY a JSON array of objects with:
- "title": concise task description
- "dueDate": "YYYY-MM-DD" or null
- "dueTime": "HH:MM" or null

Today is ${new Date().toISOString().split('T')[0]}. Convert relative dates to absolute.
Extract ALL actionable items — explicit and implicit. No preamble, just the JSON array.`;

            send({ type: 'delta', delta: 'Analyzing...' });
            const fullText = await aiComplete(sysPrompt, text);
            send({ type: 'delta', delta: fullText });

            let tasks = [];
            try {
                const m = fullText.match(/\[[\s\S]*\]/);
                if (m) tasks = JSON.parse(m[0]);
            } catch { send({ type: 'parse_error', raw: fullText }); }

            const result = tasks.filter(t => t.title).map(t => addTodo(t.title, t.dueDate, t.dueTime, 'extracted'));
            taskExtractCounter.add(result.length);
            incMetric('tasks', result.length);
            extractLatency.record(Date.now() - start);
            extractSpan.setAttribute('tasks.count', result.length);
            extractSpan.setStatus({ code: SpanStatusCode.OK });
            extractSpan.end();
            return result;
        });

        send({ type: 'tasks_extracted', tasks: added });
        send({ type: 'done' });
        res.end();
    } catch (err) {
        send({ type: 'error', message: err.message }); res.end();
    }
});

// ── NL command (with tool calling) ─────────────────────────────────────────

app.post('/api/command', async (req, res) => {
    // Support both legacy { command } and AG-UI { messages } payload formats
    let command = req.body.command;
    if (!command && Array.isArray(req.body.messages)) {
        const lastUser = [...req.body.messages].reverse().find(m => m.role === 'user');
        command = lastUser?.content;
    }
    if (!command) return res.status(400).json({ error: 'command required' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);

    try {
        const result = await tracer.startActiveSpan('command.process', async (cmdSpan) => {
            const start = Date.now();
            cmdSpan.setAttribute('command', command.slice(0, 200));
            commandCounter.add(1);
            incMetric('commands');

            const todoList = todos.map(t =>
                `- [${t.completed ? 'x' : ' '}] "${t.title}" (id: ${t.id}${t.dueDate ? `, due: ${t.dueDate}` : ''}${t.dueTime ? ` ${t.dueTime}` : ''}${t.reminder ? `, reminder: ${t.remindAt}` : ''})`
            ).join('\n');

            const pacific = nowPacific();
            const currentTime = pacific.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });

            const sysPrompt = `You are a todo list assistant for a local todo app.

Current time: ${currentTime} (${TZ})
Today: ${new Date().toISOString().split('T')[0]}

Current todos:
${todoList || '(empty)'}

Rules:
- Use the provided tools for any todo mutation or reminder action.
- Use add_task for plain tasks.
- Use set_reminder for timed reminders.
- Use mark_complete, mark_incomplete, and remove_task for todo updates.
- Use update_task to change title, due date/time, priority, notes, or tags on existing todos. Use for rename/reschedule/edit requests.
- Use get_current_datetime when you need to resolve relative times.
- For weather-related reminders (jacket, umbrella, rain, coat, cold), call get_weather so your final reply can include weather context.
- "when I leave for work" = 5:00 PM today, "morning" = 8:00 AM, "lunch" = 12:00 PM, "tonight" = 8:00 PM
- Match "done with X" / "finished X" to the closest todo by title
- For priority: "urgent"/"ASAP" = high, "important" = medium, "whenever"/"low priority" = low.
- Keep "reply" short, witty, and helpful
- If the user only wants information and no state change, reply normally without using tools.
- Do not invent todo IDs; use the IDs from the todo list above.
- After any tool calls, reply to the user naturally in plain text.`;

            send({ type: 'RUN_STARTED', threadId: req.body.threadId || 'default', runId: req.body.runId || 'run-' + Date.now() });
            const todosBefore = JSON.parse(JSON.stringify(todos));
            const aiResult = await aiCompleteWithNativeTools(sysPrompt, command);

            // Persist conversation for future recall
            const threadId = req.body.threadId || 'default';
            try {
                dbSaveMessage({ id: randomUUID(), threadId, role: 'user', content: command });
                for (const te of aiResult.toolExecutions) {
                    dbSaveMessage({ id: randomUUID(), threadId, role: 'assistant', toolCalls: [te] });
                    dbSaveMessage({ id: randomUUID(), threadId, role: 'tool', content: te.result, toolCallId: te.name });
                }
                if (aiResult.reply) {
                    dbSaveMessage({ id: randomUUID(), threadId, role: 'assistant', content: aiResult.reply });
                }
            } catch {} // Don't fail the request if conversation save fails

            const msgId = 'msg-' + Date.now();
            for (const toolExec of aiResult.toolExecutions) {
                send({ type: 'TOOL_CALL_START', toolCallId: 'tc-' + Date.now(), toolCallName: toolExec.name });
                // Emit tool result for rich card rendering
                send({ type: 'TOOL_CALL_END', toolCallId: 'tc-' + Date.now(), toolCallName: toolExec.name, result: toolExec.result });
            }

            // Emit STATE_DELTA for immediate incremental feedback
            try {
                const patches = jsonpatch.compare({ todos: todosBefore, recurringTemplates }, { todos, recurringTemplates });
                if (patches.length > 0) {
                    send({ type: 'STATE_DELTA', delta: patches });
                }
            } catch (_) { /* fall through to snapshot */ }

            const reply = aiResult.reply;
            if (reply) {
                send({ type: 'TEXT_MESSAGE_START', messageId: msgId, role: 'assistant' });
                send({ type: 'TEXT_MESSAGE_CONTENT', messageId: msgId, delta: reply });
                send({ type: 'TEXT_MESSAGE_END', messageId: msgId });
            }

            commandLatency.record(Date.now() - start);
            cmdSpan.setAttribute('actions.count', aiResult.toolExecutions.length);
            cmdSpan.setStatus({ code: SpanStatusCode.OK });
            cmdSpan.end();
            return aiResult;
        });

        send({ type: 'STATE_SNAPSHOT', snapshot: { todos, recurringTemplates } });
        send({ type: 'RUN_FINISHED', threadId: req.body.threadId || 'default', runId: req.body.runId || '' });
        res.end();
    } catch (err) {
        send({ type: 'RUN_ERROR', message: err.message }); res.end();
    }
});

// ── Conversation history ──────────────────────────────────────────────────
app.get('/api/conversations/:threadId', (req, res) => {
    try {
        const messages = dbGetThread(req.params.threadId);
        res.json(messages);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Process speech transcript → extract structured tasks ───────────────────
//
// ── Audio Transcription via SDK AudioClient ───────────────────────────────
// Accepts audio file upload (WAV, MP3, etc.) and transcribes using a cached
// Whisper model via the SDK's native AudioClient.

app.post('/api/transcribe', uploadAudio.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'audio file required' });

    try {
        const mgr = getFoundryManager();
        // Find a cached Whisper model
        const cachedModels = await mgr.catalog.getCachedModels();
        const preferredWhisper = serverConfig.whisperModel || null;
        let whisperVariant = preferredWhisper
            ? cachedModels.find(v => v.id === preferredWhisper)
            : null;
        if (!whisperVariant) {
            whisperVariant = cachedModels.find(v => v.alias?.toLowerCase().includes('whisper'));
        }
        if (!whisperVariant) {
            return res.status(503).json({
                error: 'No Whisper model cached. Download one from the model picker (whisper-tiny is 0.22 GB).',
                suggestion: 'Download a whisper model'
            });
        }

        // SDK AudioClient requires a file path
        const audioClient = whisperVariant.createAudioClient();
        audioClient.settings.language = serverConfig.whisperLanguage || 'en';

        const result = await audioClient.transcribe(req.file.path);
        const text = result?.text || (typeof result === 'string' ? result : '');

        res.json({ text, model: whisperVariant.id });
    } catch (err) {
        res.status(500).json({ error: `Transcription failed: ${err.message}` });
    } finally {
        // Clean up temp file
        try { fs.unlinkSync(req.file.path); } catch {}
    }
});

app.post('/api/transcribe/stream', uploadAudio.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'audio file required' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
        const mgr = getFoundryManager();
        const cachedModels = await mgr.catalog.getCachedModels();
        const preferredWhisper = serverConfig.whisperModel || null;
        let whisperVariant = preferredWhisper
            ? cachedModels.find(v => v.id === preferredWhisper)
            : null;
        if (!whisperVariant) {
            whisperVariant = cachedModels.find(v => v.alias?.toLowerCase().includes('whisper'));
        }
        if (!whisperVariant) {
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'No Whisper model cached' })}\n\n`);
            res.end();
            return;
        }

        const audioClient = whisperVariant.createAudioClient();
        audioClient.settings.language = serverConfig.whisperLanguage || 'en';

        let disconnected = false;
        req.on('close', () => { disconnected = true; });

        let fullText = '';
        for await (const chunk of audioClient.transcribeStreaming(req.file.path)) {
            if (disconnected) break;
            const text = chunk?.text || (typeof chunk === 'string' ? chunk : '');
            if (text) {
                fullText += text;
                res.write(`data: ${JSON.stringify({ type: 'partial', text, fullText })}\n\n`);
            }
        }
        res.write(`data: ${JSON.stringify({ type: 'done', text: fullText, model: whisperVariant.id })}\n\n`);
    } catch (err) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    } finally {
        try { fs.unlinkSync(req.file.path); } catch {}
        res.end();
    }
});

// ── Speech-to-tasks (text → structured extraction) ────────────────────────
// filler words, and implied context that written text rarely has.
//
// Model: configured via MODEL_ID (NPU) via Foundry Local OpenAI-compatible API.
// Extraction strategy: single-shot structured prompt → JSON parse.
// No NER/classification pipeline — the instruction-tuned LLM does it all.

app.post('/api/process-speech', async (req, res) => {
    const { text } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ success: false, error: 'text is required' });
    }

    if (!modelReady) {
        const hint = startupError
            ? `Foundry startup failed: ${startupError}`
            : 'Foundry Local model is still initializing — try again in a moment.';
        return res.status(503).json({ success: false, error: hint });
    }

    const span = tracer.startSpan('speech.process');
    const start = Date.now();
    span.setAttribute('input.length', text.length);

    try {
        // Speech transcripts often contain filler words, hedging ("maybe I should"),
        // and implied urgency ("I really need to").  The prompt accounts for all of
        // this and requests a fully self-contained JSON array so we can reliably
        // parse it without a separate validation pass.
        const sysPrompt = `You are a task-extraction engine for a speech-to-text todo app.
The input is a verbatim speech transcript that may contain filler words ("um", "uh", "like"),
run-on sentences, and implied tasks stated informally ("I really should call Dave").

Extract every actionable item and return ONLY a valid JSON array — no prose, no markdown fences.
Each element must be an object with these exact keys:
  "title"    – concise imperative task description (required, max 120 chars)
  "priority" – one of "high", "medium", or "low" (infer from urgency cues; default "medium")
  "tags"     – array of lowercase single-word or hyphenated labels (e.g. ["work","email"])
  "dueDate"  – "YYYY-MM-DD" if mentioned, otherwise null
  "dueTime"  – "HH:MM" 24-hour if mentioned, otherwise null

Priority inference rules:
  high   → words like "urgent", "ASAP", "critical", "emergency", "right away", "need to NOW"
  low    → words like "eventually", "someday", "whenever", "at some point", "no rush"
  medium → everything else

Tag inference rules (apply as many as fit):
  work, personal, health, finance, shopping, email, call, meeting, travel, home, coding

Today is ${new Date().toISOString().split('T')[0]}. Convert any relative dates to absolute YYYY-MM-DD.
If the transcript contains no actionable items, return an empty array [].
Return ONLY the JSON array, nothing else.`;

        const raw = await aiComplete(sysPrompt, text.trim());let tasks = [];
        const match = raw.match(/\[[\s\S]*\]/);
        if (match) {
            try {
                tasks = JSON.parse(match[0]);
            } catch {
                span.setAttribute('parse.failed', true);
                // Return the raw text so the caller can inspect it
                return res.status(500).json({
                    success: false,
                    error: 'Failed to parse model output as JSON',
                    raw
                });
            }
        }

        // Normalise and add valid tasks to the in-memory todo store
        const added = tasks
            .filter(t => t && typeof t.title === 'string' && t.title.trim())
            .map(t => {
                const todo = addTodo(
                    t.title.trim(),
                    t.dueDate || null,
                    t.dueTime || null,
                    'speech',
                    null
                );
                // Attach speech-specific metadata that the base todo schema doesn't have
                todo.priority = ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium';
                todo.tags = Array.isArray(t.tags) ? t.tags.map(String) : [];
                dbUpdateTodo(todo);
                return todo;
            });

        taskExtractCounter.add(added.length);
        incMetric('tasks', added.length);
        speechLatency.record(Date.now() - start);
        span.setAttribute('tasks.count', added.length);
        span.setStatus({ code: SpanStatusCode.OK });

        return res.json({ success: true, tasks: added });
    } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        span.recordException(err);
        return res.status(500).json({ success: false, error: err.message });
    } finally {
        span.end();
    }
});

// ── Test notification──────────────────────────────────────────────────────

app.post('/api/test-notification', (_req, res) => {
    reminderFiredCounter.add(1, { source: 'browser-test' });
    res.json({
        success: true,
        notification: {
            title: 'It works! 🎉',
            body: 'Browser notifications are ready. Your AI has your back.',
            url: '/'
        },
        hint: 'Trigger this from the browser after requesting notification permission.'
    });
});

// ── Telemetry API ──────────────────────────────────────────────────────────

// Snapshot: last N events from the UISpanExporter buffer
app.get('/api/telemetry/snapshot', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    res.json({ events: uiExporter.snapshot(limit), serverTime: new Date().toISOString() });
});

// Live stream: SSE endpoint; uses UISpanExporter fan-out
app.get('/api/telemetry/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    uiExporter.subscribe(res);
    // Send a health snapshot immediately so the pane has current state on connect
    const healthSnap = { id: Date.now(), ts: new Date().toISOString(), ...buildHealthSnapshot() };
    res.write(`data: ${JSON.stringify(healthSnap)}\n\n`);

    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); } }, 15_000);
    req.on('close', () => { clearInterval(ping); uiExporter.unsubscribe(res); });
});

// Start Jaeger via docker compose (called from the Traces tab UI)
app.post('/api/telemetry/start-jaeger', async (_req, res) => {
    try {
        // Check if Jaeger is already running
        try {
            const probe = await fetch('http://localhost:16686/api/services', { signal: AbortSignal.timeout(2000) });
            if (probe.ok) return res.json({ ok: true, status: 'already_running' });
        } catch {}

        // Check Docker is available
        try {
            execSync('docker info', { encoding: 'utf8', timeout: 5000, stdio: 'ignore' });
        } catch {
            return res.status(503).json({ error: 'Docker is not running. Please start Docker Desktop first.' });
        }

        // Start Jaeger via docker compose
        execSync('docker compose up -d', { cwd: __dirname, encoding: 'utf8', timeout: 60_000, stdio: 'ignore' });

        // Wait for Jaeger to become responsive
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const probe = await fetch('http://localhost:16686/api/services', { signal: AbortSignal.timeout(2000) });
                if (probe.ok) return res.json({ ok: true, status: 'started' });
            } catch {}
        }
        res.status(503).json({ error: 'Jaeger started but not responding yet. Try again in a moment.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Metric sample interval (every 5s) ─────────────────────────────────────
let _lastMetricFingerprint = '';
setInterval(() => {
    const sample = getMetricSnapshot();
    sample.todosActive = todos.filter(t => !t.completed).length;
    // Only emit when values actually change (ignore ts, id, uptimeMs)
    const fingerprint = JSON.stringify(sample);
    if (fingerprint === _lastMetricFingerprint) return;
    _lastMetricFingerprint = fingerprint;
    const event = { id: Date.now(), ts: new Date().toISOString(), type: 'metric.sample', ...sample, uptimeMs: Date.now() - SERVER_START };
    for (const res of uiExporter._listeners) {
        try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { uiExporter._listeners.delete(res); }
    }
}, 5_000);

// Clear telemetry buffer and counters
app.post('/api/telemetry/clear', (_req, res) => {
    uiExporter.clear();
    _lastMetricFingerprint = '';
    dbClearTelemetry();
    res.json({ ok: true });
});

function buildHealthSnapshot(){
    return {
        type: 'health.snapshot',
        ts: new Date().toISOString(),
        model: MODEL_ID,
        foundryUrl: FOUNDRY_URL,
        foundryReady,
        modelReady,
        mcpAvailable: !!mcpClient,
        startupError,
        uptimeMs: Date.now() - SERVER_START,
    };
}

// ════════════════════════════════════════════════════════════════════════════
// Port binding with conflict detection
// ════════════════════════════════════════════════════════════════════════════

import net from 'net';

function isPortAvailable(port) {
    return new Promise(resolve => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => { srv.close(() => resolve(true)); });
        srv.listen(port, '127.0.0.1');
    });
}

function findAvailablePort(preferred, attempts = 10) {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        let port = preferred;
        let tries = 0;
        srv.once('listening', () => {
            const bound = srv.address().port;
            srv.close(() => resolve(bound));
        });
        srv.on('error', () => {
            tries++;
            if (tries >= attempts) {
                // Let OS pick an available port
                srv.listen(0, '127.0.0.1');
            } else {
                port++;
                srv.listen(port, '127.0.0.1');
            }
        });
        srv.listen(port, '127.0.0.1');
    });
}

let _portConflictInfo = null; // tracked for AG-UI notification

async function resolvePort() {
    // Priority: env var > config > default
    const configPort = getConfig('port');
    if (process.env.taskbean_PORT) {
        EXPRESS_PORT = parseInt(process.env.taskbean_PORT, 10);
    } else if (configPort) {
        EXPRESS_PORT = parseInt(configPort, 10);
    }

    if (await isPortAvailable(EXPRESS_PORT)) return;

    // Port conflict — find alternative
    const originalPort = EXPRESS_PORT;
    EXPRESS_PORT = await findAvailablePort(originalPort);
    _portConflictInfo = { requested: originalPort, actual: EXPRESS_PORT };
    console.warn(`⚠️  Port ${originalPort} in use. The bean found port ${EXPRESS_PORT} instead.`);
    console.warn(`   Set taskbean_PORT=${EXPRESS_PORT} or update port in Settings to make it permanent.`);
}

// ════════════════════════════════════════════════════════════════════════════
// ── Projects & Agent Skills (for bean CLI integration) ────────────────────
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/projects', (_req, res) => {
    todos = dbGetAllTodos(); // refresh
    // Derive projects from todos with non-null project field
    const projectMap = {};
    for (const t of todos) {
        const p = t.project || null;
        if (!p) continue;
        if (!projectMap[p]) projectMap[p] = { name: p, total: 0, done: 0, pending: 0 };
        projectMap[p].total++;
        if (t.completed) projectMap[p].done++; else projectMap[p].pending++;
    }
    res.json(Object.values(projectMap));
});

app.get('/api/projects/tasks', (req, res) => {
    todos = dbGetAllTodos();
    const project = req.query.project;
    const filtered = project
        ? todos.filter(t => t.project === project)
        : todos.filter(t => t.project && t.source === 'agent');
    res.json(filtered);
});

// Copilot usage stats from local session-store.db
app.get('/api/copilot-usage', (req, res) => {
    const dateFilter = req.query.date || 'today';
    try {
        const copilotDbPath = path.join(os.homedir(), '.copilot', 'session-store.db');
        const sessionStatePath = path.join(os.homedir(), '.copilot', 'session-state');
        if (!fs.existsSync(copilotDbPath)) return res.json({ available: false });

        const cdb = new Database(copilotDbPath, { readonly: true, fileMustExist: true });
        cdb.pragma('busy_timeout = 3000');

        // Date filter
        let dateClause = "date(created_at) = date('now', 'localtime')";
        if (dateFilter === 'week') dateClause = "date(created_at) >= date('now', '-7 days', 'localtime')";
        else if (dateFilter === 'all') dateClause = '1=1';

        const sessions = cdb.prepare(`SELECT id, cwd, summary, created_at FROM sessions WHERE ${dateClause} ORDER BY created_at DESC`).all();
        cdb.close();

        let totalTokens = 0;
        let totalMessages = 0;
        let totalTurns = 0;
        const models = {};
        const sessionDetails = [];

        for (const s of sessions) {
            const evPath = path.join(sessionStatePath, s.id, 'events.jsonl');
            if (!fs.existsSync(evPath)) continue;
            let sessionTokens = 0;
            let sessionMsgs = 0;
            let model = null;
            const lines = fs.readFileSync(evPath, 'utf-8').split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const ev = JSON.parse(line);
                    if (ev.type === 'session.start') {
                        model = ev.data?.selectedModel || 'unknown';
                        models[model] = (models[model] || 0) + 1;
                    }
                    if (ev.type === 'assistant.message' && ev.data?.outputTokens) {
                        sessionTokens += ev.data.outputTokens;
                        sessionMsgs++;
                    }
                    if (ev.type === 'user.message') totalTurns++;
                } catch {}
            }
            totalTokens += sessionTokens;
            totalMessages += sessionMsgs;
            sessionDetails.push({
                id: s.id,
                summary: s.summary,
                model,
                outputTokens: sessionTokens,
                messages: sessionMsgs,
                createdAt: s.created_at,
                cwd: s.cwd,
            });
        }

        res.json({
            available: true,
            period: dateFilter,
            sessions: sessions.length,
            totalOutputTokens: totalTokens,
            totalMessages,
            totalTurns,
            models,
            details: sessionDetails,
        });
    } catch (err) {
        res.json({ available: false, error: err.message });
    }
});

// ── Task Detail (enriched with Copilot session data) ──────────────────────

function parseSessionEvents(sessionId) {
    const evPath = path.join(os.homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
    const result = { model: null, outputTokens: 0, turns: 0, tools: {}, taskCompleteSummary: null };
    if (!fs.existsSync(evPath)) return result;
    try {
        const lines = fs.readFileSync(evPath, 'utf-8').split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const ev = JSON.parse(line);
                if (ev.type === 'session.start') result.model = ev.data?.selectedModel || 'unknown';
                else if (ev.type === 'user.message') result.turns++;
                else if (ev.type === 'assistant.message') result.outputTokens += (ev.data?.outputTokens || 0);
                else if (ev.type === 'tool.execution_start') {
                    const name = ev.data?.toolName || 'unknown';
                    result.tools[name] = (result.tools[name] || 0) + 1;
                }
                else if (ev.type === 'session.task_complete') result.taskCompleteSummary = ev.data?.summary;
                else if (ev.type === 'session.model_change') result.model = ev.data?.newModel || result.model;
            } catch {}
        }
    } catch {}
    return result;
}

function correlateSession(task) {
    const copilotDbPath = path.join(os.homedir(), '.copilot', 'session-store.db');
    if (!fs.existsSync(copilotDbPath)) return null;
    let cdb;
    try {
        cdb = new Database(copilotDbPath, { readonly: true, fileMustExist: true });
        cdb.pragma('busy_timeout = 3000');
    } catch { return null; }

    try {
        const project = task.project || '';
        const createdAt = task.created_at || '';
        let candidates = [];

        // Strategy 1: project path + time proximity
        if (project && createdAt) {
            candidates = cdb.prepare(
                `SELECT id, cwd, summary, repository, branch, created_at FROM sessions
                 WHERE cwd LIKE ? AND abs(strftime('%s', created_at) - strftime('%s', ?)) < 1800
                 ORDER BY abs(strftime('%s', created_at) - strftime('%s', ?)) ASC LIMIT 5`
            ).all(`%${project}%`, createdAt, createdAt);
        }

        // Strategy 2: time only
        if (!candidates.length && createdAt) {
            candidates = cdb.prepare(
                `SELECT id, cwd, summary, repository, branch, created_at FROM sessions
                 WHERE abs(strftime('%s', created_at) - strftime('%s', ?)) < 1800
                 ORDER BY abs(strftime('%s', created_at) - strftime('%s', ?)) ASC LIMIT 5`
            ).all(createdAt, createdAt);
        }

        return candidates.length ? candidates[0] : null;
    } catch { return null; }
    finally { try { cdb.close(); } catch {} }
}

function buildTaskDetail(taskId) {
    const task = db.prepare('SELECT * FROM todos WHERE id = ?').get(taskId);
    if (!task) return null;

    const sessionRow = correlateSession(task);
    let sessionData = null, files = [], refs = [], tools = {}, checkpoint = null;

    if (sessionRow) {
        const sid = sessionRow.id;
        const evData = parseSessionEvents(sid);
        tools = evData.tools;

        sessionData = {
            id: sid, summary: sessionRow.summary, model: evData.model,
            branch: sessionRow.branch, repository: sessionRow.repository,
            outputTokens: evData.outputTokens, turns: evData.turns,
            taskCompleteSummary: evData.taskCompleteSummary, createdAt: sessionRow.created_at,
        };

        // Files, refs, checkpoint from Copilot DB
        const copilotDbPath = path.join(os.homedir(), '.copilot', 'session-store.db');
        let cdb2;
        try {
            cdb2 = new Database(copilotDbPath, { readonly: true, fileMustExist: true });
            cdb2.pragma('busy_timeout = 3000');
            files = cdb2.prepare('SELECT file_path, tool_name, turn_index FROM session_files WHERE session_id = ? ORDER BY turn_index').all(sid)
                .map(r => ({ path: r.file_path, tool: r.tool_name, turn: r.turn_index }));
            refs = cdb2.prepare('SELECT ref_type, ref_value FROM session_refs WHERE session_id = ?').all(sid)
                .map(r => ({ type: r.ref_type, value: r.ref_value }));
            const cpRow = cdb2.prepare('SELECT title, overview, work_done, technical_details FROM checkpoints WHERE session_id = ? ORDER BY checkpoint_number DESC LIMIT 1').get(sid);
            if (cpRow) checkpoint = { title: cpRow.title, overview: cpRow.overview, workDone: cpRow.work_done, technicalDetails: cpRow.technical_details };
        } catch {}
        finally { try { cdb2?.close(); } catch {} }
    }

    return {
        task: { id: task.id, title: task.title, completed: !!task.completed, project: task.project, source: task.source, created_at: task.created_at },
        session: sessionData, files, refs, tools, checkpoint,
    };
}

app.get('/api/task-detail/:taskId', (req, res) => {
    const detail = buildTaskDetail(req.params.taskId);
    if (!detail) return res.status(404).json({ error: 'Task not found' });
    res.json(detail);
});

app.get('/api/task-detail/:taskId/export', (req, res) => {
    const detail = buildTaskDetail(req.params.taskId);
    if (!detail) return res.status(404).json({ error: 'Task not found' });

    if (req.query.format === 'json') return res.json(detail);

    // Markdown export
    const t = detail.task, s = detail.session;
    const status = t.completed ? '✅' : '⏳';
    let lines = [`## ${status} ${t.title}`, ''];

    const meta = [];
    if (t.project) meta.push(`**Project**: ${t.project}`);
    if (s?.branch) meta.push(`**Branch**: ${s.branch}`);
    if (t.created_at) { try { meta.push(`**Date**: ${new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`); } catch {} }
    if (meta.length) lines.push(meta.join(' · '));

    if (s) {
        const ai = [];
        if (s.model) ai.push(`**AI Model**: ${s.model}`);
        if (s.turns) ai.push(`**Turns**: ${s.turns}`);
        if (s.outputTokens) ai.push(`**Tokens**: ${s.outputTokens.toLocaleString()}`);
        if (ai.length) lines.push(ai.join(' · '));
    }
    lines.push('');

    const summary = s?.taskCompleteSummary || detail.checkpoint?.overview;
    if (summary) { lines.push('### Summary', summary, ''); }

    if (detail.files.length) {
        lines.push('### Files Changed');
        detail.files.forEach(f => lines.push(`- \`${f.path}\` — ${f.tool || 'unknown'}${f.turn != null ? ` (turn ${f.turn})` : ''}`));
        lines.push('');
    }

    if (Object.keys(detail.tools).length) {
        const toolStrs = Object.entries(detail.tools).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ×${c}`);
        lines.push('### Tools Used', toolStrs.join(', '), '');
    }

    if (detail.refs.length) {
        lines.push('### References');
        detail.refs.forEach(r => lines.push(`- ${r.type}: ${r.value}`));
        lines.push('');
    }

    res.type('text/markdown').send(lines.join('\n'));
});

app.get('/api/report', (req, res) => {
    todos = dbGetAllTodos();
    const dateRange = req.query.date || 'week';
    const projectFilter = req.query.project;
    const fmt = req.query.format || 'json';

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let since;
    switch (dateRange) {
        case 'today': since = today; break;
        case 'yesterday': since = new Date(today); since.setDate(since.getDate() - 1); break;
        case 'week': since = new Date(today); since.setDate(since.getDate() - 7); break;
        case 'all': since = new Date(0); break;
        default: since = new Date(today); since.setDate(since.getDate() - 7);
    }

    let filtered = todos.filter(t => new Date(t.createdAt) >= since);
    if (projectFilter) filtered = filtered.filter(t => t.project === projectFilter);

    if (fmt === 'json') {
        return res.json({ period: dateRange, since: since.toISOString(), tasks: filtered });
    }

    // Markdown
    const byProject = {};
    for (const t of filtered) {
        const p = t.project || 'manual';
        if (!byProject[p]) byProject[p] = [];
        byProject[p].push(t);
    }
    const done = filtered.filter(t => t.completed).length;
    let md = `# 📋 taskbean report — ${dateRange}\n\n`;
    md += `**Generated**: ${now.toLocaleString()}\n\n`;
    md += `## Summary\n- **Completed**: ${done}\n- **Pending**: ${filtered.length - done}\n- **Total**: ${filtered.length}\n\n`;
    for (const [proj, tasks] of Object.entries(byProject)) {
        md += `## 📁 ${proj}\n\n`;
        const d = tasks.filter(t => t.completed);
        const p = tasks.filter(t => !t.completed);
        if (d.length) {
            md += `### ✅ Completed\n| Task | Source |\n|------|--------|\n`;
            for (const t of d) md += `| ${t.title} | ${t.source} |\n`;
            md += '\n';
        }
        if (p.length) {
            md += `### ⬚ Pending\n| Task | Source |\n|------|--------|\n`;
            for (const t of p) md += `| ${t.title} | ${t.source} |\n`;
            md += '\n';
        }
    }
    res.type('text/markdown').send(md);
});

await resolvePort();

app.get('/api/port-info', (_req, res) => {
    res.json({
        port: EXPRESS_PORT,
        default: DEFAULT_PORT,
        conflict: _portConflictInfo,
        configurable: true,
    });
});

app.post('/api/port', (req, res) => {
    const { port } = req.body || {};
    if (!port || typeof port !== 'number' || port < 1024 || port > 65535) {
        return res.status(400).json({ error: 'Port must be a number between 1024 and 65535' });
    }
    setConfig('port', port);
    res.json({ ok: true, port, message: `Port set to ${port}. Restart taskbean for it to take effect.` });
});

app.listen(EXPRESS_PORT, '127.0.0.1', () => {
    console.log(`\n🎉 Open http://localhost:${EXPRESS_PORT}`);
    if (_portConflictInfo) {
        console.log(`   (wanted ${_portConflictInfo.requested}, fell back to ${EXPRESS_PORT})`);
    }
    console.log('');
    // Emit initial health snapshot via SSE so it's available immediately
    setTimeout(() => {
        const healthEvent = { id: Date.now(), ts: new Date().toISOString(), ...buildHealthSnapshot() };
        for (const res of uiExporter._listeners) {
            try { res.write(`data: ${JSON.stringify(healthEvent)}\n\n`); } catch { uiExporter._listeners.delete(res); }
        }
    }, 500);
    // Emit port conflict notification if applicable
    if (_portConflictInfo) {
        setTimeout(() => {
            const event = { id: Date.now(), ts: new Date().toISOString(), type: 'port.conflict', ..._portConflictInfo };
            for (const res of uiExporter._listeners) {
                try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { uiExporter._listeners.delete(res); }
            }
        }, 1000);
    }
});

async function shutdown() {
    console.log('\n🛑 Shutting down...');
    try { if (mcpClient) await mcpClient.close(); } catch {}
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
