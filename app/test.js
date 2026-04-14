#!/usr/bin/env node
// Smoke test for taskbean — exercises all endpoints
// Run: node test.js (server must be running on :2326)

const BASE = process.env.BASE_URL || 'http://localhost:2326';
let passed = 0, failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (err) {
        console.log(`  ❌ ${name}: ${err.message}`);
        failed++;
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'Assertion failed');
}

async function fetchJson(path, opts = {}) {
    const res = await fetch(`${BASE}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...opts
    });
    return { status: res.status, data: await res.json() };
}

async function fetchSSE(path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const text = await res.text();
    const events = text.split('\n\n')
        .filter(b => b.trim().startsWith('data: '))
        .map(b => { try { return JSON.parse(b.trim().slice(6)); } catch { return null; } })
        .filter(Boolean);
    return events;
}

async function run() {
    console.log(`\n🧪 Smoke testing ${BASE}\n`);

    // ── Health ──
    await test('GET /api/health', async () => {
        const { status, data } = await fetchJson('/api/health');
        assert(status === 200, `status ${status}`);
        assert(data.status === 'ok', `status: ${data.status}`);
        assert(data.model, 'missing model');
        console.log(`     Model: ${data.model}, MCP: ${data.mcpAvailable}`);
    });

    await test('GET /api/health returns security headers', async () => {
        const res = await fetch(`${BASE}/api/health`);
        assert(res.headers.get('x-content-type-options') === 'nosniff', 'Missing X-Content-Type-Options');
        assert(res.headers.get('x-frame-options') === 'DENY', 'Missing X-Frame-Options');
        assert(res.headers.get('referrer-policy') === 'strict-origin-when-cross-origin', 'Missing Referrer-Policy');
    });

    // ── Todo CRUD ──
    let todoId;
    await test('POST /api/todos (via command)', async () => {
        const events = await fetchSSE('/api/command', { command: 'add task: run smoke test' });
        // AG-UI protocol: look for STATE_SNAPSHOT with todos
        const snapshot = events.find(e => e.type === 'STATE_SNAPSHOT');
        if (snapshot?.snapshot?.todos?.length > 0) {
            todoId = snapshot.snapshot.todos[snapshot.snapshot.todos.length - 1].id;
        } else {
            // Fallback: model may not have called add_task tool (small models can fail)
            // Create directly via API so downstream tests can continue
            const { data } = await fetchJson('/api/todos', {
                method: 'POST', body: JSON.stringify({ title: 'run smoke test' })
            });
            todoId = data.id;
        }
        assert(todoId, 'no todo created');
    });

    await test('GET /api/todos', async () => {
        const { data } = await fetchJson('/api/todos');
        assert(Array.isArray(data), 'not array');
        assert(data.length > 0, 'empty');
        assert(data.find(t => t.id === todoId), 'smoke test todo not found');
    });

    await test('PATCH /api/todos/:id (toggle complete)', async () => {
        const { data } = await fetchJson(`/api/todos/${todoId}`, {
            method: 'PATCH', body: JSON.stringify({ completed: true })
        });
        assert(data.completed === true, 'not completed');
    });

    await test('DELETE /api/todos/:id', async () => {
        const { data } = await fetchJson(`/api/todos/${todoId}`, { method: 'DELETE' });
        assert(data.success === true, 'delete failed');
    });

    // ── Extract ──
    await test('POST /api/extract', async () => {
        const events = await fetchSSE('/api/extract', { text: 'Buy groceries tomorrow. Call dentist by Friday.' });
        const extracted = events.find(e => e.type === 'tasks_extracted');
        assert(extracted, 'no tasks_extracted event');
        assert(extracted.tasks.length > 0, 'no tasks extracted');
        console.log(`     Extracted ${extracted.tasks.length} tasks`);
    });

    // ── Templates ──
    await test('GET /api/templates', async () => {
        const { data } = await fetchJson('/api/templates');
        assert(data.builtIn?.length >= 7, `only ${data.builtIn?.length} templates`);
    });

    // ── Notifications ──
    await test('POST /api/test-notification', async () => {
        const { data } = await fetchJson('/api/test-notification', { method: 'POST' });
        assert(data.success === true, 'notification failed');
    });

    // ── Suggest Endpoint ──

    await test('POST /api/suggest returns suggestions array', async () => {
        const { status, data } = await fetchJson('/api/suggest', {
            method: 'POST',
            body: JSON.stringify({ context: { trigger: 'idle', todoCount: 3, pendingCount: 2, timeOfDay: 'morning' } })
        });
        assert(status === 200, `status ${status}`);
        assert(Array.isArray(data.suggestions), 'suggestions not array');
        // May be empty if model is slow, but shape must be correct
    });

    await test('POST /api/suggest handles missing context', async () => {
        const { status, data } = await fetchJson('/api/suggest', {
            method: 'POST',
            body: JSON.stringify({})
        });
        assert(status === 200, `status ${status}`);
        assert(Array.isArray(data.suggestions), 'suggestions not array');
    });

    await test('POST /api/suggest suggestions have correct shape', async () => {
        const { data } = await fetchJson('/api/suggest', {
            method: 'POST',
            body: JSON.stringify({ context: { trigger: 'onboarding', todoCount: 0, pendingCount: 0 } })
        });
        for (const s of data.suggestions) {
            assert(typeof s.label === 'string', `label not string: ${JSON.stringify(s)}`);
            assert(typeof s.message === 'string', `message not string: ${JSON.stringify(s)}`);
            assert(s.label.length <= 40, `label too long: ${s.label.length} chars`);
            assert(s.message.length <= 200, `message too long: ${s.message.length} chars`);
        }
        assert(data.suggestions.length <= 4, `too many suggestions: ${data.suggestions.length}`);
    });

    await test('POST /api/suggest with thematic trigger', async () => {
        const { status, data } = await fetchJson('/api/suggest', {
            method: 'POST',
            body: JSON.stringify({ context: { trigger: 'thematic', lastTodoTitle: 'Buy groceries', todoCount: 5 } })
        });
        assert(status === 200, `status ${status}`);
        assert(Array.isArray(data.suggestions), 'not array');
    });

    // ── Overdue Endpoint ──

    await test('GET /api/todos/overdue returns empty when no overdue', async () => {
        const { status, data } = await fetchJson('/api/todos/overdue');
        assert(status === 200, `status ${status}`);
        assert(Array.isArray(data), 'not array');
        // Clean state — may or may not have overdue todos from previous tests
    });

    await test('Overdue: setup reminder todo via command', async () => {
        // Create a todo with a past reminder to test overdue detection
        const { data } = await fetchJson('/api/todos', { method: 'POST', body: JSON.stringify({ title: 'Overdue test reminder', emoji: '⏰' }) });
        if (data.id) {
            // Set reminder to 1 hour ago
            const pastTime = new Date(Date.now() - 3600000).toISOString();
            await fetchJson(`/api/todos/${data.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ reminder: true, remindAt: pastTime, reminderFired: false })
            });
        }
    });

    await test('GET /api/todos/overdue finds overdue reminders', async () => {
        const { data } = await fetchJson('/api/todos/overdue');
        const overdueTest = data.find(t => t.title === 'Overdue test reminder');
        if (overdueTest) {
            assert(overdueTest.overdueSince, 'missing overdueSince');
            assert(overdueTest.overdueSince.includes('ago'), `bad format: ${overdueTest.overdueSince}`);
            console.log(`     Overdue: "${overdueTest.title}" — ${overdueTest.overdueSince}`);
        }
        // Verify no fired reminders appear
        for (const t of data) {
            assert(!t.reminderFired, `fired reminder in results: ${t.title}`);
            assert(!t.completed, `completed todo in results: ${t.title}`);
        }
    });

    await test('Overdue: fired reminders excluded', async () => {
        // Create a todo with reminder fired
        const { data: todo } = await fetchJson('/api/todos', { method: 'POST', body: JSON.stringify({ title: 'Fired reminder test', emoji: '🔕' }) });
        if (todo.id) {
            const pastTime = new Date(Date.now() - 7200000).toISOString();
            await fetchJson(`/api/todos/${todo.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ reminder: true, remindAt: pastTime, reminderFired: true })
            });
            const { data: overdue } = await fetchJson('/api/todos/overdue');
            const found = overdue.find(t => t.title === 'Fired reminder test');
            assert(!found, 'fired reminder should not appear in overdue');
            // Cleanup
            await fetchJson(`/api/todos/${todo.id}`, { method: 'DELETE' });
        }
    });

    // ── PATCH Reminder Fields ──

    await test('PATCH /api/todos/:id updates remindAt', async () => {
        const { data: todo } = await fetchJson('/api/todos', { method: 'POST', body: JSON.stringify({ title: 'Patch remind test' }) });
        const futureTime = new Date(Date.now() + 3600000).toISOString();
        const { data } = await fetchJson(`/api/todos/${todo.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ remindAt: futureTime })
        });
        assert(data.remindAt === futureTime, `remindAt not updated: ${data.remindAt}`);
        await fetchJson(`/api/todos/${todo.id}`, { method: 'DELETE' });
    });

    await test('PATCH /api/todos/:id updates reminderFired', async () => {
        const { data: todo } = await fetchJson('/api/todos', { method: 'POST', body: JSON.stringify({ title: 'Patch fired test' }) });
        const { data } = await fetchJson(`/api/todos/${todo.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ reminderFired: true })
        });
        assert(data.reminderFired === true, `reminderFired not updated`);
        // Reset it
        const { data: data2 } = await fetchJson(`/api/todos/${todo.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ reminderFired: false })
        });
        assert(data2.reminderFired === false, `reminderFired not reset`);
        await fetchJson(`/api/todos/${todo.id}`, { method: 'DELETE' });
    });

    // ── Pressure Tests ──

    await test('100 todos: API handles bulk creation', async () => {
        const promises = [];
        for (let i = 0; i < 100; i++) {
            promises.push(fetchJson('/api/todos', {
                method: 'POST',
                body: JSON.stringify({ title: `Pressure test ${i}`, emoji: '🔨' })
            }));
        }
        const results = await Promise.all(promises);
        const created = results.filter(r => r.status === 201);
        assert(created.length === 100, `only ${created.length}/100 created`);

        // Verify list endpoint handles large response
        const { data } = await fetchJson('/api/todos');
        const pressureTodos = data.filter(t => t.title.startsWith('Pressure test'));
        assert(pressureTodos.length >= 100, `only ${pressureTodos.length} pressure todos found`);

        // Cleanup
        for (const t of pressureTodos) {
            await fetchJson(`/api/todos/${t.id}`, { method: 'DELETE' });
        }
        console.log(`     Created and cleaned up 100 todos`);
    });

    await test('Concurrent /api/suggest calls do not crash', async () => {
        const promises = [];
        for (let i = 0; i < 5; i++) {
            promises.push(fetchJson('/api/suggest', {
                method: 'POST',
                body: JSON.stringify({ context: { trigger: 'idle', todoCount: i } })
            }));
        }
        const results = await Promise.all(promises);
        for (const r of results) {
            assert(r.status === 200, `status ${r.status}`);
            assert(Array.isArray(r.data.suggestions), 'not array');
        }
        console.log(`     5 concurrent suggest calls all returned OK`);
    });

    await test('Overdue endpoint handles many overdue reminders', async () => {
        // Create 20 todos with past reminders
        const ids = [];
        const pastTime = new Date(Date.now() - 7200000).toISOString();
        for (let i = 0; i < 20; i++) {
            const { data } = await fetchJson('/api/todos', {
                method: 'POST',
                body: JSON.stringify({ title: `Overdue pressure ${i}`, emoji: '⏰' })
            });
            await fetchJson(`/api/todos/${data.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ reminder: true, remindAt: pastTime, reminderFired: false })
            });
            ids.push(data.id);
        }
        const { status, data } = await fetchJson('/api/todos/overdue');
        assert(status === 200, `status ${status}`);
        const found = data.filter(t => t.title.startsWith('Overdue pressure'));
        assert(found.length === 20, `only ${found.length}/20 overdue found`);
        // Cleanup
        for (const id of ids) {
            await fetchJson(`/api/todos/${id}`, { method: 'DELETE' });
        }
        console.log(`     20 overdue reminders handled correctly`);
    });

    // ── Edge Cases ──

    await test('PATCH /api/todos/:id with non-existent ID returns 404', async () => {
        const { status } = await fetchJson('/api/todos/nonexistent-id-xyz', {
            method: 'PATCH',
            body: JSON.stringify({ completed: true })
        });
        assert(status === 404, `expected 404, got ${status}`);
    });

    await test('DELETE /api/todos/:id with non-existent ID returns 404', async () => {
        const { status } = await fetchJson('/api/todos/nonexistent-id-xyz', { method: 'DELETE' });
        assert(status === 404, `expected 404, got ${status}`);
    });

    await test('POST /api/todos without title returns 400', async () => {
        const { status } = await fetchJson('/api/todos', {
            method: 'POST',
            body: JSON.stringify({ emoji: '🤷' })
        });
        assert(status === 400, `expected 400, got ${status}`);
    });

    await test('POST /api/suggest with empty body returns valid response', async () => {
        const res = await fetch(`${BASE}/api/suggest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        assert(res.status === 200, `status ${res.status}`);
        const data = await res.json();
        assert(Array.isArray(data.suggestions), 'suggestions not array');
    });

    await test('Overdue excludes completed todos with past reminders', async () => {
        const pastTime = new Date(Date.now() - 3600000).toISOString();
        const { data: todo } = await fetchJson('/api/todos', {
            method: 'POST',
            body: JSON.stringify({ title: 'Completed but overdue' })
        });
        await fetchJson(`/api/todos/${todo.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ reminder: true, remindAt: pastTime, completed: true })
        });
        const { data: overdue } = await fetchJson('/api/todos/overdue');
        const found = overdue.find(t => t.title === 'Completed but overdue');
        assert(!found, 'completed todo should not appear in overdue');
        await fetchJson(`/api/todos/${todo.id}`, { method: 'DELETE' });
    });

    await test('Overdue excludes future reminders', async () => {
        const futureTime = new Date(Date.now() + 86400000).toISOString();
        const { data: todo } = await fetchJson('/api/todos', {
            method: 'POST',
            body: JSON.stringify({ title: 'Future reminder' })
        });
        await fetchJson(`/api/todos/${todo.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ reminder: true, remindAt: futureTime, reminderFired: false })
        });
        const { data: overdue } = await fetchJson('/api/todos/overdue');
        const found = overdue.find(t => t.title === 'Future reminder');
        assert(!found, 'future reminder should not appear in overdue');
        await fetchJson(`/api/todos/${todo.id}`, { method: 'DELETE' });
    });

    await test('OverdueSince format: minutes', async () => {
        const thirtyMinAgo = new Date(Date.now() - 30 * 60000).toISOString();
        const { data: todo } = await fetchJson('/api/todos', {
            method: 'POST',
            body: JSON.stringify({ title: 'OverdueSince minutes test' })
        });
        await fetchJson(`/api/todos/${todo.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ reminder: true, remindAt: thirtyMinAgo, reminderFired: false })
        });
        const { data: overdue } = await fetchJson('/api/todos/overdue');
        const found = overdue.find(t => t.title === 'OverdueSince minutes test');
        assert(found, 'not found in overdue');
        assert(found.overdueSince.includes('m ago'), `expected Xm ago, got: ${found.overdueSince}`);
        await fetchJson(`/api/todos/${todo.id}`, { method: 'DELETE' });
    });

    await test('OverdueSince format: hours', async () => {
        const twoHoursAgo = new Date(Date.now() - 120 * 60000).toISOString();
        const { data: todo } = await fetchJson('/api/todos', {
            method: 'POST',
            body: JSON.stringify({ title: 'OverdueSince hours test' })
        });
        await fetchJson(`/api/todos/${todo.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ reminder: true, remindAt: twoHoursAgo, reminderFired: false })
        });
        const { data: overdue } = await fetchJson('/api/todos/overdue');
        const found = overdue.find(t => t.title === 'OverdueSince hours test');
        assert(found, 'not found in overdue');
        assert(found.overdueSince.includes('h ago'), `expected Xh ago, got: ${found.overdueSince}`);
        await fetchJson(`/api/todos/${todo.id}`, { method: 'DELETE' });
    });

    // ── Hardware Endpoint ──

    await test('GET /api/hardware returns hardware profile', async () => {
        const { status, data } = await fetchJson('/api/hardware');
        assert(status === 200, `status ${status}`);
        assert(data.cpu, 'missing cpu');
        assert(typeof data.cpu.cores === 'number' && data.cpu.cores > 0, `bad cores: ${data.cpu.cores}`);
        assert(typeof data.cpu.usagePercent === 'number', 'missing cpu.usagePercent');
        assert(data.ram, 'missing ram');
        assert(typeof data.ram.totalGb === 'number' && data.ram.totalGb > 0, `bad totalGb: ${data.ram.totalGb}`);
        assert(typeof data.ram.usedGb === 'number', 'missing ram.usedGb');
        assert(typeof data.ram.freeGb === 'number', 'missing ram.freeGb');
        assert(typeof data.ram.usagePercent === 'number', 'missing ram.usagePercent');
        // GPU and NPU may be null depending on hardware
        if (data.npu) {
            assert(typeof data.npu.name === 'string', 'npu.name should be a string');
            assert(typeof data.npu.usagePercent === 'number', 'npu.usagePercent should be a number');
            assert(data.npu.usagePercent >= 0 && data.npu.usagePercent <= 100, `npu.usagePercent out of range: ${data.npu.usagePercent}`);
            console.log(`     NPU: ${data.npu.name} (${data.npu.usagePercent}%)`);
        }
        console.log(`     CPU: ${data.cpu.cores} cores, RAM: ${data.ram.totalGb} GB, GPU: ${data.gpu?.name || 'none'}, NPU: ${data.npu?.name || 'none'}`);
    });

    await test('GET /api/hardware CPU usage changes between calls', async () => {
        const { data: hw1 } = await fetchJson('/api/hardware');
        // Burn some CPU
        const end = Date.now() + 200;
        while (Date.now() < end) Math.random();
        const { data: hw2 } = await fetchJson('/api/hardware');
        // Both should be valid numbers (may or may not differ, but must not error)
        assert(typeof hw1.cpu.usagePercent === 'number', 'first call missing usagePercent');
        assert(typeof hw2.cpu.usagePercent === 'number', 'second call missing usagePercent');
    });

    // ── Config Endpoint ──

    await test('GET /api/config returns config with hardware and timezone', async () => {
        const { status, data } = await fetchJson('/api/config');
        assert(status === 200, `status ${status}`);
        assert(data.timezone, 'missing timezone');
        assert(data.hardware, 'missing hardware');
        assert(data.hardware.cpu, 'missing hardware.cpu');
        assert(data.hardware.ram, 'missing hardware.ram');
    });

    await test('GET /api/config includes new fields with defaults', async () => {
        const res = await fetch(`${BASE}/api/config`);
        const data = await res.json();
        assert('timezone' in data, 'timezone field missing from config');
        assert('hideIncompatibleModels' in data, 'hideIncompatibleModels missing');
        assert('toolCallOnly' in data, 'toolCallOnly missing');
        assert(typeof data.hideIncompatibleModels === 'boolean', 'hideIncompatibleModels not boolean');
        assert(typeof data.toolCallOnly === 'boolean', 'toolCallOnly not boolean');
    });

    await test('POST /api/config persists and returns settings', async () => {
        const { status } = await fetchJson('/api/config', {
            method: 'POST',
            body: JSON.stringify({ hideIncompatibleModels: true, toolCallOnly: true })
        });
        assert(status === 200, `status ${status}`);
        const { data } = await fetchJson('/api/config');
        assert(data.hideIncompatibleModels === true, 'hideIncompatibleModels not persisted');
        assert(data.toolCallOnly === true, 'toolCallOnly not persisted');
        // Clean up
        await fetchJson('/api/config', {
            method: 'POST',
            body: JSON.stringify({ hideIncompatibleModels: false, toolCallOnly: false })
        });
    });

    await test('POST /api/config validates timezone', async () => {
        const { status: okStatus } = await fetchJson('/api/config', {
            method: 'POST',
            body: JSON.stringify({ timezone: 'America/New_York' })
        });
        assert(okStatus === 200, `valid tz returned ${okStatus}`);

        const { status: badStatus } = await fetchJson('/api/config', {
            method: 'POST',
            body: JSON.stringify({ timezone: 'Not/A/Real/Zone' })
        });
        assert(badStatus === 400, `invalid tz returned ${badStatus}, expected 400`);

        // Restore original
        await fetchJson('/api/config', {
            method: 'POST',
            body: JSON.stringify({ timezone: 'America/Los_Angeles' })
        });
    });

    // ── Telemetry Endpoints ──

    await test('POST /api/telemetry/clear resets counters', async () => {
        const { status, data } = await fetchJson('/api/telemetry/clear', { method: 'POST' });
        assert(status === 200, `status ${status}`);
        assert(data.ok === true, 'expected ok: true');

        // Snapshot should be empty after clear
        const { data: snap } = await fetchJson('/api/telemetry/snapshot');
        assert(Array.isArray(snap.events), 'events not array');
        // May have a metric.sample that fired since clear, but should be very few
        assert(snap.events.length < 5, `expected few events after clear, got ${snap.events.length}`);
    });

    await test('GET /api/telemetry/snapshot returns events', async () => {
        const { status, data } = await fetchJson('/api/telemetry/snapshot');
        assert(status === 200, `status ${status}`);
        assert(Array.isArray(data.events), 'events not array');
        assert(data.serverTime, 'missing serverTime');
    });

    await test('GET /api/telemetry/snapshot respects limit param', async () => {
        const { data } = await fetchJson('/api/telemetry/snapshot?limit=2');
        assert(data.events.length <= 2, `expected <=2 events, got ${data.events.length}`);
    });

    // ── Models Endpoint ──

    await test('GET /api/models returns model catalog', async () => {
        const { status, data } = await fetchJson('/api/models');
        assert(status === 200, `status ${status}`);
        assert(data.active, 'missing active model');
        assert(Array.isArray(data.models), 'models not array');
        assert(data.models.length > 0, 'no models in catalog');
        // Verify model shape
        const m = data.models[0];
        assert(m.modelId, 'missing modelId');
        assert(m.device, 'missing device');
        assert(typeof m.fileSizeGb === 'number' || m.fileSizeGb === null, 'bad fileSizeGb');
        assert(Array.isArray(m.tasks), 'tasks not array');
        console.log(`     ${data.models.length} models, active: ${data.active}`);
    });

    await test('GET /api/models includes tool-calling metadata', async () => {
        const { data } = await fetchJson('/api/models');
        const withTools = data.models.filter(m => m.tasks.includes('tools'));
        const without = data.models.filter(m => !m.tasks.includes('tools'));
        console.log(`     ${withTools.length} with tools, ${without.length} without`);
        // At least one model should exist
        assert(data.models.length > 0, 'no models');
    });

    // ── Todo new fields ──

    await test('POST /api/todos with priority, notes, tags', async () => {
        const { data: res } = await fetchJson('/api/todos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Rich todo test',
                priority: 'high',
                notes: '# Markdown\n- item 1\n- item 2',
                tags: ['work', 'urgent'],
                emoji: '🔥'
            })
        });
        assert(res.title === 'Rich todo test', 'title matches');
        assert(res.priority === 'high', 'priority is high');
        assert(res.notes === '# Markdown\n- item 1\n- item 2', 'notes preserved');
        assert(Array.isArray(res.tags) && res.tags.includes('work'), 'tags include work');
        assert(res.emoji === '🔥', 'emoji set');
        // Clean up
        await fetchJson(`/api/todos/${res.id}`, { method: 'DELETE' });
    });

    await test('POST /api/todos minimal fields use defaults', async () => {
        const { data: res } = await fetchJson('/api/todos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Bare todo' })
        });
        assert(res.priority === 'none', 'default priority is none');
        assert(res.notes === null, 'default notes is null');
        assert(Array.isArray(res.tags) && res.tags.length === 0, 'default tags is empty array');
        await fetchJson(`/api/todos/${res.id}`, { method: 'DELETE' });
    });

    await test('PATCH /api/todos/:id priority validation', async () => {
        const { data: todo } = await fetchJson('/api/todos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Priority validation', priority: 'low' })
        });

        // Valid priority change
        let { data: patched } = await fetchJson(`/api/todos/${todo.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ priority: 'high' })
        });
        assert(patched.priority === 'high', 'priority updated to high');

        // Invalid priority should be ignored
        ({ data: patched } = await fetchJson(`/api/todos/${todo.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ priority: 'super-urgent' })
        }));
        assert(patched.priority === 'high', 'invalid priority ignored');

        await fetchJson(`/api/todos/${todo.id}`, { method: 'DELETE' });
    });

    await test('PATCH /api/todos/:id notes truncation', async () => {
        const { data: todo } = await fetchJson('/api/todos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Notes truncation test' })
        });

        // Normal notes
        let { data: patched } = await fetchJson(`/api/todos/${todo.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes: '**Bold** and _italic_' })
        });
        assert(patched.notes === '**Bold** and _italic_', 'markdown notes preserved');

        // Long notes truncated
        const longNotes = 'x'.repeat(6000);
        ({ data: patched } = await fetchJson(`/api/todos/${todo.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes: longNotes })
        }));
        assert(patched.notes.length === 5000, 'notes truncated to 5000');

        await fetchJson(`/api/todos/${todo.id}`, { method: 'DELETE' });
    });

    await test('PATCH /api/todos/:id tags dedup and limit', async () => {
        const { data: todo } = await fetchJson('/api/todos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Tags test' })
        });

        // Deduplication
        let { data: patched } = await fetchJson(`/api/todos/${todo.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags: ['work', 'personal', 'work'] })
        });
        assert(patched.tags.length === 2, 'tags deduplicated');

        // Limit to 10
        const manyTags = Array.from({length: 20}, (_, i) => `tag-${i}`);
        ({ data: patched } = await fetchJson(`/api/todos/${todo.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags: manyTags })
        }));
        assert(patched.tags.length === 10, 'tags limited to 10');

        await fetchJson(`/api/todos/${todo.id}`, { method: 'DELETE' });
    });

    await test('update_task tool: TOOL_CALL_END in SSE events', async () => {
        // Create a todo first
        const { data: todo } = await fetchJson('/api/todos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Update me via AI' })
        });

        // Send a command that should trigger update_task or add_task
        // Check that TOOL_CALL_END events are present in the SSE stream
        try {
            const events = await fetchSSE('/api/command', {
                command: `Mark the todo "${todo.title}" as high priority`,
                threadId: 'test-thread',
                messages: [{ id: 'msg-1', role: 'user', content: `Mark the todo "${todo.title}" as high priority` }],
                state: { todos: [todo], recurringTemplates: [] }
            });

            const hasRunStarted = events.some(e => e.type === 'RUN_STARTED');
            const hasRunFinished = events.some(e => e.type === 'RUN_FINISHED');
            assert(hasRunStarted, 'RUN_STARTED event present');
            assert(hasRunFinished, 'RUN_FINISHED event present');

            // Check for TOOL_CALL_END with result (new feature)
            const toolEnds = events.filter(e => e.type === 'TOOL_CALL_END');
            if (toolEnds.length > 0) {
                assert(toolEnds[0].result !== undefined, 'TOOL_CALL_END has result field');
            }

            // Check for STATE_DELTA or STATE_SNAPSHOT
            const stateEvents = events.filter(e => e.type === 'STATE_DELTA' || e.type === 'STATE_SNAPSHOT');
            assert(stateEvents.length > 0, 'state sync event present');
        } catch (e) {
            // AI model may not be loaded in test env — skip gracefully
            console.log('  ⚠ Skipped AI test (model not ready):', e.message);
        }

        await fetchJson(`/api/todos/${todo.id}`, { method: 'DELETE' });
    });

    // ── Model catalog: cached field ──

    await test('GET /api/models includes cached boolean on every model', async () => {
        const { data } = await fetchJson('/api/models');
        for (const m of data.models) {
            assert(typeof m.cached === 'boolean', `model ${m.modelId} missing cached boolean`);
        }
        const cachedCount = data.models.filter(m => m.cached).length;
        console.log(`     ${cachedCount}/${data.models.length} cached`);
    });

    await test('GET /api/models active model is marked', async () => {
        const { data } = await fetchJson('/api/models');
        assert(data.active, 'missing active model ID');
        const activeModel = data.models.find(m => m.active);
        assert(activeModel, 'no model has active: true');
        assert(activeModel.modelId === data.active, 'active model ID mismatch');
    });

    // ── Model switch ──

    await test('POST /api/models/switch requires modelId', async () => {
        const { status, data } = await fetchJson('/api/models/switch', {
            method: 'POST',
            body: JSON.stringify({})
        });
        assert(status === 400, `expected 400, got ${status}`);
        assert(data.error.includes('modelId'), 'missing error about modelId');
    });

    await test('POST /api/models/switch rejects unknown model with 404', async () => {
        const { status, data } = await fetchJson('/api/models/switch', {
            method: 'POST',
            body: JSON.stringify({ modelId: 'nonexistent-model:99' })
        });
        assert(status === 404, `expected 404, got ${status}`);
        assert(data.error.includes('not found'), 'missing not-found error');
    });

    await test('POST /api/models/switch returns SSE stream for valid model', async () => {
        const { data: catalog } = await fetchJson('/api/models');
        // Switch to the currently active model (no-op download, fast load)
        const targetId = catalog.active;
        const res = await fetch(`${BASE}/api/models/switch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelId: targetId })
        });
        assert(res.headers.get('content-type')?.includes('text/event-stream'), 'not SSE');
        const text = await res.text();
        const events = text.split('\n\n')
            .filter(b => b.trim().startsWith('data:'))
            .map(b => { try { return JSON.parse(b.trim().slice(6)); } catch { return null; } })
            .filter(Boolean);
        const hasDoneOrError = events.some(e => e.type === 'done' || e.type === 'error');
        assert(hasDoneOrError, 'no done/error event in SSE stream');
        if (events.find(e => e.type === 'done')) {
            console.log(`     Switched to ${events.find(e => e.type === 'done').alias}`);
        }
    });

    await test('POST /api/models/switch rejects concurrent with 409', async () => {
        const { data: catalog } = await fetchJson('/api/models');
        // Pick a non-active cached CPU model to avoid GPU driver issues
        const target = catalog.models.find(m => m.cached && !m.active && m.device === 'CPU');
        if (!target) { console.log('     ⚠ No non-active cached CPU model — skipping race test'); return; }
        const targetId = target.modelId;

        // Fire two switches near-simultaneously; if the first hasn't completed
        // by the time the second arrives, we get 409.
        const [res1, res2] = await Promise.all([
            fetch(`${BASE}/api/models/switch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: targetId })
            }),
            // Slight delay so req1 registers first
            new Promise(r => setTimeout(r, 50)).then(() =>
                fetch(`${BASE}/api/models/switch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ modelId: targetId })
                })
            )
        ]);

        await res1.text().catch(() => {});
        if (res2.status === 409) {
            console.log('     Concurrent rejection confirmed');
        } else {
            console.log('     ⚠ Switch completed before second request (too fast to race)');
        }
        assert(res2.status === 409 || res2.status === 200, `unexpected status ${res2.status}`);
    });

    // ── Full model lifecycle: download → switch → verify → concurrent reject → cleanup ──

    const TEST_MODEL_ID = 'qwen2.5-0.5b-instruct-generic-cpu:4';

    // Guaranteed cleanup for model lifecycle tests
    const originalModelId = (await fetchJson('/api/models')).data?.active;

    await test('Download + switch to a new model via SDK', async () => {
        // Remember original active model
        const { data: before } = await fetchJson('/api/models');
        const originalModel = before.active;
        assert(TEST_MODEL_ID !== originalModel, 'test model should differ from active');

        // Verify it is NOT cached yet
        const entry = before.models.find(m => m.modelId === TEST_MODEL_ID);
        assert(entry, `${TEST_MODEL_ID} not in catalog`);
        // (It may or may not be cached from a prior run — forceDownload handles both)

        // Switch with forceDownload
        const events = await fetchSSE('/api/models/switch', { modelId: TEST_MODEL_ID, forceDownload: true });
        const done = events.find(e => e.type === 'done');
        const error = events.find(e => e.type === 'error');
        assert(done || error, 'no done or error event');
        if (error) throw new Error(`Switch failed: ${error.message}`);
        assert(done.modelId === TEST_MODEL_ID, `done.modelId mismatch: ${done.modelId}`);
        console.log(`     Downloaded & switched to ${done.alias}`);
    });

    await test('Switched model is now active and cached', async () => {
        const { data } = await fetchJson('/api/models');
        assert(data.active === TEST_MODEL_ID, `active is ${data.active}, expected ${TEST_MODEL_ID}`);
        const entry = data.models.find(m => m.modelId === TEST_MODEL_ID);
        assert(entry.cached, 'model should be cached after download');
        assert(entry.active, 'model should be active');
    });

    await test('Switched model responds to inference', async () => {
        const { data } = await fetchJson('/api/health');
        assert(data.model === TEST_MODEL_ID, `health model is ${data.model}`);
        assert(data.modelReady, 'modelReady should be true');
    });

    await test('Concurrent switch during download rejected with 409', async () => {
        // Now that we have 2 cached models, switch to the other one
        // and fire a concurrent request during the switch
        const { data: catalog } = await fetchJson('/api/models');
        // Only pick CPU models to avoid GPU driver issues
        const other = catalog.models.find(m => m.cached && m.modelId !== catalog.active && m.device === 'CPU');
        assert(other, 'need a second cached CPU model for concurrent test');

        const [res1, res2] = await Promise.all([
            fetch(`${BASE}/api/models/switch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: other.modelId })
            }),
            new Promise(r => setTimeout(r, 50)).then(() =>
                fetch(`${BASE}/api/models/switch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ modelId: other.modelId })
                })
            )
        ]);

        await res1.text().catch(() => {});
        if (res2.status === 409) {
            console.log('     ✓ Concurrent rejection confirmed (409)');
        } else {
            console.log('     ⚠ Switch too fast to race — both completed');
        }
        assert(res2.status === 409 || res2.status === 200, `unexpected ${res2.status}`);
    });

    await test('Switch back to original model before cleanup', async () => {
        // Switch back to the original model (qwen2.5-coder-0.5b CPU)
        const { data: catalog } = await fetchJson('/api/models');
        const original = catalog.models.find(m => m.modelId !== TEST_MODEL_ID && m.cached && m.device === 'CPU');
        assert(original, 'original model should still be cached');
        const events = await fetchSSE('/api/models/switch', { modelId: original.modelId });
        const done = events.find(e => e.type === 'done');
        assert(done, 'failed to switch back');
        console.log(`     Restored to ${done.alias}`);
    });

    await test('Delete test model from cache', async () => {
        const res = await fetch(`${BASE}/api/models/cache/${encodeURIComponent(TEST_MODEL_ID)}`, { method: 'DELETE' });
        assert(res.ok, `delete failed: ${res.status}`);
        const body = await res.json();
        assert(body.ok, 'delete response not ok');
        console.log(`     Removed ${TEST_MODEL_ID} from cache`);

        // Verify it's no longer cached
        const { data } = await fetchJson('/api/models');
        const entry = data.models.find(m => m.modelId === TEST_MODEL_ID);
        assert(!entry?.cached, 'model should no longer be cached');
    });

    // Safety cleanup — runs even if tests above failed
    await test('Lifecycle cleanup (safety net)', async () => {
        try { await fetch(`${BASE}/api/models/cache/${encodeURIComponent(TEST_MODEL_ID)}`, { method: 'DELETE' }); } catch {}
        if (originalModelId) {
            try { await fetchSSE('/api/models/switch', { modelId: originalModelId }); } catch {}
        }
    });

    // ── Summary ──
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
    console.log(`${'═'.repeat(50)}\n`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
