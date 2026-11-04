import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { resolveTrustedCopilotSession, resolveTrustedPullRequest, sessionDeepLink, validatedUuid } from "./session-links.mjs";
import { getAvailability as describeAvailability } from "./availability.mjs";
import { BeanCommandError, runBean } from "./bean-runner.mjs";
import { LinkError, launchUrl, navigationSupport } from "./link-launcher.mjs";
import { rowActions } from "./row-actions.mjs";

const servers = new Map();
let session;
let beanQueue = Promise.resolve();
const EXTENSION_FILE = fileURLToPath(import.meta.url);

const STATUS_LABELS = {
    pending: "Pending",
    in_progress: "In progress",
    blocked: "Blocked",
    done: "Done",
};

const STATUS_ORDER = ["pending", "in_progress", "blocked", "done"];
const PERIODS = new Set(["today", "week", "all"]);
const ORIGIN_ALIASES = new Map([
    ["coreai-microsoft_slide-factory", "slide-factory"],
    ["skills-pr", "skill-store"],
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKTREE_RE = /^(?:(?:nbrady-microsoft|nicholasdbrady)-(?:issue-\d+-)?[a-z0-9]+(?:-[a-z0-9]+){1,}(?:-[a-f0-9]{6})?|[a-z0-9]+(?:-[a-z0-9]+)+-[a-f0-9]{7,8})$/i;
const COPILOT_CHAT_PATH_RE = /[\\/]\.copilot[\\/]chats[\\/](?:\d{4}-\d{2}-\d{2}[\\/])?([^\\/]+)$/i;


function pathLeaf(value) {
    const parts = String(value || "").split(/[\\/]+/).filter(Boolean);
    return parts.at(-1) || "";
}

function titleOrigin(title) {
    const match = String(title || "").match(/^\[Preserved recovery\]\s+([A-Za-z0-9._-]+):\s*/i);
    if (!match) return null;
    const raw = match[1];
    return { raw, label: ORIGIN_ALIASES.get(raw) || raw, prefix: match[0] };
}

function isSessionOrigin(value) {
    return UUID_RE.test(value) || WORKTREE_RE.test(value);
}


function resolveSessionIdentity(task, raw, path) {
    const pathMatch = path.match(COPILOT_CHAT_PATH_RE);
    const slug = pathMatch?.[1] || (WORKTREE_RE.test(raw) ? raw : "");
    const trusted = resolveTrustedCopilotSession(task, { slug });
    if (!pathMatch && !trusted && !slug) return null;
    const id = trusted?.id || "";
    const name = trusted?.name || "";
    return {
        id,
        href: sessionDeepLink(id),
        slug,
        name,
        label: name || slug || "Copilot session",
        resolvedName: Boolean(name),
        detail: ["Copilot session", id ? `Session ID: ${id}` : "", slug ? `Workspace: ${slug}` : "", path ? `Path: ${path}` : ""].filter(Boolean).join(" · "),
    };
}

function resolveTaskOrigin(task) {
    const raw = String(task.project || "").trim();
    const path = String(task.project_path || "").trim();
    const sessionIdentity = resolveSessionIdentity(task, raw, path);
    const standaloneSession = Boolean(path.match(COPILOT_CHAT_PATH_RE) || /[\\/]\.copilot[\\/]session-state[\\/]/i.test(path) || isSessionOrigin(raw) || isSessionOrigin(pathLeaf(path)));
    const fromTitle = titleOrigin(task.title);
    const repoMatch = path.match(/[\\/]\.copilot[\\/]repos[\\/]([^\\/]+)$/i);
    if (fromTitle && !repoMatch && !standaloneSession) {
        return {
            key: `workspace:${fromTitle.label}`,
            label: fromTitle.label,
            kind: "workspace",
            raw,
            path,
            detail: [raw && raw !== fromTitle.label ? `Execution origin: ${raw}` : "", sessionIdentity?.detail || ""].filter(Boolean).join(" · "),
            titlePrefix: fromTitle.prefix,
            session: sessionIdentity,
        };
    }

    const aliased = ORIGIN_ALIASES.get(raw);
    if (aliased) {
        return { key: `workspace:${aliased}`, label: aliased, kind: "workspace", raw, path, detail: [`Execution origin: ${raw}`, sessionIdentity?.detail || ""].filter(Boolean).join(" · "), titlePrefix: "", session: sessionIdentity };
    }

    const leaf = pathLeaf(path);
    if (repoMatch && !isSessionOrigin(repoMatch[1])) {
        const label = ORIGIN_ALIASES.get(repoMatch[1]) || repoMatch[1];
        return { key: `repository:${label}`, label, kind: "repository", raw, path, detail: raw && raw !== label ? `Execution origin: ${raw}` : "", titlePrefix: "", session: sessionIdentity };
    }

    if (sessionIdentity && standaloneSession) {
        const stableKey = sessionIdentity.id || sessionIdentity.slug || raw || leaf;
        return { key: `copilot-session:${stableKey}`, label: sessionIdentity.label, kind: "copilot-session", raw, path, detail: sessionIdentity.detail, titlePrefix: "", session: sessionIdentity };
    }

    if (!raw && !leaf) return { key: "unresolved", label: "Unresolved workspace", kind: "unresolved", raw, path, detail: "No origin recorded", titlePrefix: "" };
    const label = raw || leaf || "Unresolved workspace";
    return { key: `workspace:${label}`, label, kind: "workspace", raw, path, detail: [raw && raw !== label ? `Execution origin: ${raw}` : "", sessionIdentity?.detail || ""].filter(Boolean).join(" · "), titlePrefix: "", session: sessionIdentity };
}
function execBeanUnqueued(args) {
    return runBean(args);
}

function execBean(args) {
    const next = beanQueue.then(() => execBeanUnqueued(args), () => execBeanUnqueued(args));
    beanQueue = next.catch(() => {});
    return next;
}

function errorText(error) {
    if (error instanceof Error) return error.message;
    return String(error || "");
}

function redact(text) {
    let value = String(text || "").replace(/\s+/g, " ").trim();
    for (const dir of [homedir(), process.env.USERPROFILE, process.env.HOME].filter(Boolean)) {
        value = value.split(dir).join("~");
    }
    return value.length > 200 ? `${value.slice(0, 197)}...` : value;
}

const BEAN_ERRORS = {
    cli_unavailable: ["taskbean_cli_unavailable", 503, false, () => "The Taskbean CLI is not available in this environment. Check that `bean` is installed and on PATH."],
    busy: ["taskbean_busy", 503, true, () => "Taskbean is busy writing to its local database. Wait a moment, then try again."],
    task_not_found: ["task_not_found", 404, false, () => "That Taskbean task no longer exists. Refresh the dashboard."],
    cli_usage: ["taskbean_cli_usage", 400, false, (e) => `Taskbean CLI rejected the command: ${redact(e.message)}`],
    cli_rejected: ["taskbean_cli_rejected", 400, false, (e) => `Taskbean CLI rejected the request: ${redact(e.message)}`],
    interrupted: ["taskbean_cli_interrupted", 503, true, () => "The Taskbean CLI was interrupted. Try again."],
    cli_failed: ["taskbean_cli_failed", 502, true, (e) => `Taskbean CLI failed (exit ${e.exitCode ?? "unknown"}): ${redact(e.message)}`],
};

function sanitizeError(error) {
    const message = errorText(error);

    if (error instanceof LinkError) {
        const unavailable = error.code === "taskbean_link_unavailable";
        return { code: error.code, message: error.message, status: unavailable ? 409 : 502, retryable: !unavailable };
    }

    if (error instanceof BeanCommandError && BEAN_ERRORS[error.kind]) {
        const [code, status, retryable, describe] = BEAN_ERRORS[error.kind];
        return { code, message: describe(error), status, retryable };
    }

    if (/database is locked|SQLITE_BUSY|ERR_SQLITE_ERROR|errcode:\s*5/i.test(message)) {
        return {
            code: "taskbean_busy",
            message: "Taskbean is busy writing to its local database. Wait a moment, then try again.",
            status: 503,
            retryable: true,
        };
    }

    if (/Could not find the taskbean CLI/i.test(message)) {
        return {
            code: "taskbean_cli_unavailable",
            message: "The Taskbean CLI is not available in this environment. Check that `bean` is installed and on PATH.",
            status: 503,
            retryable: false,
        };
    }

    if (/non-JSON output/i.test(message)) {
        return {
            code: "taskbean_bad_response",
            message: "Taskbean returned an unexpected response. Try again, or check the extension log for details.",
            status: 502,
            retryable: true,
        };
    }

    if (/Request body is too large/i.test(message)) {
        return {
            code: "request_too_large",
            message: "That request is too large for the dashboard to process.",
            status: 413,
            retryable: false,
        };
    }

    if (/Request body must be valid JSON/i.test(message)) {
        return {
            code: "invalid_request",
            message: "The dashboard received an invalid request. Refresh the canvas and try again.",
            status: 400,
            retryable: false,
        };
    }

    if (error?.code === "missing_title" || /Task title is required/i.test(message)) {
        return {
            code: "missing_title",
            message: "Task title is required.",
            status: 400,
            retryable: false,
        };
    }

    if (error?.code === "missing_task_id" || /Task id is required/i.test(message)) {
        return {
            code: "missing_task_id",
            message: "Task id is required.",
            status: 400,
            retryable: false,
        };
    }

    if (error?.code === "unknown_action" || /Unknown action|Unsupported task mutation/i.test(message)) {
        return {
            code: "unknown_action",
            message: "That Taskbean dashboard action is not supported.",
            status: 400,
            retryable: false,
        };
    }

    return {
        code: "taskbean_dashboard_error",
        message: "Taskbean Dashboard hit a runtime error. Try again, or check the extension log for details.",
        status: 500,
        retryable: true,
    };
}

async function logError(scope, error) {
    const detail = error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) };
    try {
        await session?.log(`Taskbean Dashboard ${scope} failed.`, {
            level: "error",
            ephemeral: true,
            data: detail,
        });
    } catch {
        console.error(`Taskbean Dashboard ${scope} failed.`, detail);
    }
}

async function withSafeErrors(scope, operation) {
    try {
        return await operation();
    } catch (error) {
        await logError(scope, error);
        const safe = sanitizeError(error);
        throw new CanvasError(safe.code, safe.message);
    }
}

async function beanJson(args) {
    const output = await execBean(args);
    if (!output) return null;
    try {
        return JSON.parse(output);
    } catch (error) {
        throw new Error(`Taskbean returned non-JSON output for "bean ${args.join(" ")}": ${output.slice(0, 500)}`);
    }
}

function normalizeTags(value) {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    if (typeof value !== "string") return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function normalizeTask(task) {
    const status = task.status || (task.completed ? "done" : "pending");
    const tags = normalizeTags(task.tags);
    const normalizedSource = { ...task, status, tags };
    const origin = resolveTaskOrigin(normalizedSource);
    const displayTitle = origin.titlePrefix
        ? String(task.title || "").slice(origin.titlePrefix.length).trim() || task.title
        : task.title;
    return {
        ...normalizedSource,
        statusLabel: STATUS_LABELS[status] || status,
        completed: Number(task.completed || 0) === 1,
        displayTitle,
        origin,
        pullRequest: resolveTrustedPullRequest(normalizedSource),
        needsYou: needsYouEvidence(normalizedSource),
    };
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function beginningOfToday() {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
}

function beginningOfWeek() {
    const date = beginningOfToday();
    const day = date.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    date.setDate(date.getDate() + mondayOffset);
    return date;
}

function taskDate(task) {
    const values = task.status === "done"
        ? [task.completed_at, task.updated_at, task.created_at, task.due_date]
        : [task.updated_at, task.created_at, task.due_date, task.completed_at];
    for (const value of values) {
        if (!value) continue;
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return null;
}

function explicitTagValue(tags, prefix) {
    const needle = `${prefix}:`;
    const tag = asArray(tags).find((value) => String(value).toLowerCase().startsWith(needle));
    return tag ? String(tag).slice(needle.length).trim() : "";
}

function needsYouEvidence(task) {
    const rawTags = asArray(task.tags).map((value) => String(value).trim());
    const tags = new Set(rawTags.map((value) => value.toLowerCase()));
    const taggedReason = ["blocker", "blocked", "reason", "needs-you", "needs_you", "hitl", "approval-required", "review-required"]
        .map((prefix) => explicitTagValue(rawTags, prefix)).find(Boolean) || "";
    const note = String(task.blocker_reason || task.blocked_reason || taggedReason || task.notes || "").trim();
    if (task.status === "blocked") return { kind: "Blocked", detail: note };
    if (tags.has("hitl") || tags.has("human-in-the-loop")) return { kind: "HITL gate", detail: note };
    if (tags.has("needs-you") || tags.has("needs_you")) return { kind: "Needs you", detail: note };
    if (tags.has("approval-required") || tags.has("review-required")) return { kind: "Approval", detail: note };
    return null;
}

function outcomeDescriptor(task) {
    const explicitOutcome = String(task.outcome || task.outcome_name || explicitTagValue(task.tags, "outcome") || "").trim();
    if (explicitOutcome) return { key: `outcome:${explicitOutcome.toLowerCase()}`, label: explicitOutcome, type: "Outcome", basis: "Explicit outcome metadata" };

    const explicitInitiative = String(task.initiative || task.initiative_name || explicitTagValue(task.tags, "initiative") || explicitTagValue(task.tags, "workstream") || "").trim();
    if (explicitInitiative) return { key: `initiative:${explicitInitiative.toLowerCase()}`, label: explicitInitiative, type: "Workstream", basis: "Explicit initiative metadata" };

    const product = String(task.product || explicitTagValue(task.tags, "product") || explicitTagValue(task.tags, "repository") || explicitTagValue(task.tags, "repo") || "").trim();
    if (product) return { key: `workstream:product:${product.toLowerCase()}`, label: product, type: "Workstream", basis: "Exact product or repository metadata" };

    if (task.origin && ["repository", "workspace"].includes(task.origin.kind) && task.origin.label) {
        return { key: `workstream:origin:${task.origin.key}`, label: task.origin.label, type: "Workstream", basis: `Exact ${task.origin.kind} origin` };
    }

    if (task.origin?.kind === "copilot-session") {
        return { key: task.origin.key, label: task.origin.label, type: "Copilot session", basis: task.origin.session?.resolvedName ? "Recorded Copilot session mapping" : "Copilot session identity from recorded path or ID" };
    }

    const convention = String(task.displayTitle || task.title || "").match(/^\[([^\]]{2,48})\]\s+/);
    if (convention) {
        const label = convention[1].trim();
        return { key: `workstream:title:${label.toLowerCase()}`, label, type: "Workstream", basis: "Shared bracketed title convention" };
    }

    return { key: "unsorted", label: "Unsorted work", type: "Unsorted", basis: "No reliable outcome or workstream evidence" };
}

function buildOutcomeGroups(tasks) {
    const groups = new Map();
    for (const task of tasks) {
        const outcome = outcomeDescriptor(task);
        const current = groups.get(outcome.key) || { ...outcome, tasks: [], needsYou: 0, newestAt: null };
        current.tasks.push(task);
        if (task.needsYou) current.needsYou += 1;
        const stamp = taskDate(task)?.getTime() || 0;
        current.newestAt = Math.max(current.newestAt || 0, stamp);
        groups.set(outcome.key, current);
    }
    return [...groups.values()].map((group) => {
        const sessionIds = new Set(group.tasks.map((task) => task.origin?.session?.id).filter(Boolean));
        if (sessionIds.size === 1 && group.tasks.every((task) => task.origin?.session?.id === [...sessionIds][0])) {
            group.sessionId = [...sessionIds][0];
            group.sessionHref = sessionDeepLink(group.sessionId);
            group.sessionName = group.tasks.find((task) => task.origin?.session?.name)?.origin.session.name || "";
        }
        return group;
    }).sort((a, b) =>
        Number(b.needsYou > 0) - Number(a.needsYou > 0)
        || b.newestAt - a.newestAt
        || a.label.localeCompare(b.label)
    );
}

function matchesPeriod(task, period) {
    if (!period || period === "all") return true;
    const date = taskDate(task);
    if (!date) return false;
    if (period === "today") return date >= beginningOfToday();
    if (period === "week") return date >= beginningOfWeek();
    return true;
}

function applyFilters(tasks, filters = {}) {
    const period = PERIODS.has(filters.period) ? filters.period : "week";
    const status = filters.status || "all";
    const project = filters.project || "all";
    const search = String(filters.search || "").trim().toLowerCase();

    return tasks.filter((task) => {
        if (!matchesPeriod(task, period)) return false;
        if (status !== "all" && task.status !== status) return false;
        if (project !== "all" && task.origin?.key !== project && task.project !== project) return false;
        if (search) {
            const haystack = [
                task.title,
                task.project,
                task.project_path,
                task.origin?.label,
                task.origin?.detail,
                task.priority,
                task.notes,
                task.agent,
                task.agent_session_id,
                task.session_name,
                task.chat_name,
                task.conversation_name,
                ...(Array.isArray(task.tags) ? task.tags : []),
            ].filter(Boolean).join(" ").toLowerCase();
            if (!haystack.includes(search)) return false;
        }
        return true;
    });
}

function summarize(tasks, projects) {
    const byStatus = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0]));
    const byWorkspace = new Map();

    for (const task of tasks) {
        byStatus[task.status] = (byStatus[task.status] || 0) + 1;
        if (task.origin?.key) byWorkspace.set(task.origin.key, (byWorkspace.get(task.origin.key) || 0) + 1);
    }

    return {
        total: tasks.length,
        byStatus,
        projects: asArray(projects).length,
        activeProjects: byWorkspace.size,
        activeWorkspaces: byWorkspace.size,
    };
}

const SUGGESTION_LIMIT = 10;

// Read-only view of pending Chronicle suggestions. They are proposals, never accepted outcomes.
async function loadSuggestedEvidence() {
    try {
        const result = await beanJson(["chronicle", "suggestions", "--status", "pending", "--json"]);
        const rows = asArray(result?.suggestions)
            .slice()
            .sort((a, b) => String(b.occurred_at || "").localeCompare(String(a.occurred_at || "")) || String(a.id).localeCompare(String(b.id)));
        return {
            available: true,
            reason: null,
            count: Number(result?.count ?? rows.length),
            items: rows.slice(0, SUGGESTION_LIMIT).map((item) => ({
                id: String(item.id || ""),
                title: String(item.suggested_title || "Untitled suggestion"),
                project: item.suggested_project ? String(item.suggested_project) : null,
                confidence: Number(item.confidence) || 0,
                occurred_at: item.occurred_at || null,
                summary: String(item.evidence_summary || "").slice(0, 200),
                state: "suggestion",
            })),
        };
    } catch (error) {
        return { available: false, reason: sanitizeError(error).message, count: 0, items: [] };
    }
}

// User-initiated observe-only collection. Writes proposals and a checkpoint only;
// the CLI guarantees no auto-link and no task changes in --observe mode.
async function observeEvidence() {
    const result = await beanJson(["chronicle", "reconcile", "--observe", "--json"]);
    return {
        mode: result?.mode || "observe",
        available: Boolean(result?.available),
        reason: result?.reason || null,
        counts: result?.counts || {},
        has_more: Boolean(result?.has_more),
        excluded: Number(result?.excluded || 0),
        checkpoint: result?.checkpoint || null,
        tasksChanged: 0,
    };
}

async function loadDashboard(input = {}) {
    const filters = {
        period: PERIODS.has(input.period) ? input.period : "week",
        status: input.status || "all",
        project: input.project || "all",
        search: input.search || "",
    };

    const [rawTasks, projects, navigation, suggestedEvidence] = await Promise.all([
        beanJson(["list", "--all", "--json"]),
        beanJson(["projects", "--all", "--json"]),
        navigationSupport(linkLauncherOptions()),
        loadSuggestedEvidence(),
    ]);

    const allTasks = asArray(rawTasks).map(normalizeTask);
    const projectScopeTasks = applyFilters(allTasks, { ...filters, project: "all" });
    const filteredTasks = applyFilters(allTasks, filters);
    const workspaceCounts = new Map();
    for (const task of projectScopeTasks) {
        const current = workspaceCounts.get(task.origin.key) || { key: task.origin.key, label: task.origin.label, kind: task.origin.kind, count: 0, details: new Set() };
        current.count += 1;
        if (task.origin.detail) current.details.add(task.origin.detail);
        workspaceCounts.set(task.origin.key, current);
    }
    const labelTotals = new Map();
    for (const value of workspaceCounts.values()) labelTotals.set(value.label.toLowerCase(), (labelTotals.get(value.label.toLowerCase()) || 0) + 1);
    const workspaces = [...workspaceCounts.values()].map((value) => ({
        key: value.key,
        label: value.label,
        displayLabel: labelTotals.get(value.label.toLowerCase()) > 1 ? `${value.label} · ${value.kind}` : value.label,
        kind: value.kind,
        count: value.count,
    })).sort((a, b) => a.displayLabel.localeCompare(b.displayLabel) || a.key.localeCompare(b.key));
    const lanes = Object.fromEntries(STATUS_ORDER.map((status) => [status, filteredTasks.filter((task) => task.status === status)]));
    const outcomeGroups = buildOutcomeGroups(filteredTasks);

    return {
        generatedAt: new Date().toISOString(),
        filters,
        tasks: filteredTasks,
        allTaskCount: allTasks.length,
        workspaceTaskCount: projectScopeTasks.length,
        lanes,
        outcomeGroups,
        needsYou: filteredTasks.filter((task) => task.needsYou),
        projects: asArray(projects),
        workspaces,
        summary: summarize(filteredTasks, projects),
        navigation,
        suggestedEvidence,
    };
}

async function generateReport(input = {}) {
    const date = PERIODS.has(input.period) ? input.period : "week";
    return beanJson(["report", "--date", date, "--json"]);
}

async function mutateTask(action, input = {}) {
    if (!input.id || typeof input.id !== "string") {
        throw new CanvasError("missing_task_id", "Task id is required.");
    }
    const commandByAction = {
        start_task: "start",
        complete_task: "done",
        block_task: "block",
    };
    const command = commandByAction[action];
    if (!command) throw new CanvasError("unknown_action", `Unsupported task mutation: ${action}`);
    return beanJson([command, input.id, "--json"]);
}

async function addTask(input = {}) {
    const title = String(input.title || "").trim();
    if (!title) throw new CanvasError("missing_title", "Task title is required.");

    const args = ["add", title, "--json"];
    if (input.project) args.push("--project", String(input.project));
    if (input.key) args.push("--key", String(input.key));
    return beanJson(args);
}

function linkLauncherOptions() {
    // Test seam: the eval harness injects a fake spawner so tests never launch real URLs.
    return globalThis[Symbol.for("taskbean.dashboard.linkLauncher")] || {};
}

async function openLink(input = {}) {
    const target = input.target;
    const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
    const requestedSession = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    if (target !== "session" && target !== "pull_request") {
        throw new LinkError("taskbean_link_unavailable", "Choose a Copilot session or pull request to open.");
    }
    if (requestedSession && !validatedUuid(requestedSession)) {
        throw new LinkError("taskbean_link_unavailable", "That Copilot session ID is not valid.");
    }
    if (!taskId && !(target === "session" && requestedSession)) {
        throw new LinkError("taskbean_link_unavailable", "Choose a task to open.");
    }

    const tasks = asArray(await beanJson(["list", "--all", "--json"])).map(normalizeTask);
    const task = taskId ? tasks.find((item) => String(item.id) === taskId) : null;
    if (taskId && !task) throw new LinkError("taskbean_link_unavailable", "That task is no longer in the Taskbean ledger.");

    const options = linkLauncherOptions();
    if (target === "session") {
        const wanted = validatedUuid(requestedSession);
        const session = task
            ? task.origin?.session
            : tasks.map((item) => item.origin?.session).find((candidate) => candidate?.id === wanted);
        if (!session?.id || (wanted && session.id !== wanted)) {
            throw new LinkError("taskbean_link_unavailable", "No trusted Copilot session is recorded for this task.");
        }
        return launchUrl(sessionDeepLink(session.id), options);
    }

    const pr = task.pullRequest;
    if (!pr?.href) throw new LinkError("taskbean_link_unavailable", "No trusted pull request is recorded for this task.");
    return launchUrl(pr.href, options);
}

async function routeApi(action, input) {
    if (action === "get_dashboard") return loadDashboard(input);
    if (action === "generate_report") return generateReport(input);
    if (action === "add_task") return addTask(input);
    if (action === "open_link") return openLink(input);
    if (action === "observe_evidence") return observeEvidence();
    if (["start_task", "complete_task", "block_task"].includes(action)) return mutateTask(action, input);
    throw new CanvasError("unknown_action", `Unknown action: ${action}`);
}

function sendJson(res, status, body) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(body));
}

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 1024 * 1024) {
                reject(new Error("Request body is too large."));
                req.destroy();
            }
        });
        req.on("end", () => {
            if (!body) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(new Error("Request body must be valid JSON."));
            }
        });
        req.on("error", reject);
    });
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function renderHtml(token) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="icon" href="data:,"><title>Taskbean Dashboard</title>
<style>
:root{color-scheme:light dark;--bg:var(--background-color-default,#FFFBF5);--surface:var(--background-color-muted,#FFFFFF);--raised:var(--background-color-emphasis,#F0E8DE);--border:var(--border-color-default,#D4C4B0);--text:var(--text-color-default,#2C1810);--muted:var(--text-color-muted,#6E5840);--focus:var(--color-focus-outline,#C8520A);--accent:var(--true-color-orange,#C8520A);--accent-text:#FFFFFF;--accent-strong:#A94508;--warn:#9A5F0E;--agent:#7D4E8F;--danger:var(--true-color-red,#B4382A);--danger-soft:var(--true-color-red-muted,#FBE7E3);--success:var(--true-color-green,#3F7F31);--blue:var(--true-color-blue,#2F6690);--r:10px}
@media(prefers-color-scheme:dark){:root{--bg:var(--background-color-default,#1A120E);--surface:var(--background-color-muted,#241A14);--raised:var(--background-color-emphasis,#2E221A);--border:var(--border-color-default,#4A3828);--text:var(--text-color-default,#E8DDD0);--muted:var(--text-color-muted,#B3A08C);--focus:var(--color-focus-outline,#E8863C);--accent:var(--true-color-orange,#E8863C);--accent-text:#1A120E;--accent-strong:#F09A55;--warn:#E0A548;--agent:#C9A0D8;--danger:var(--true-color-red,#F07A6C);--danger-soft:var(--true-color-red-muted,#3A1C17);--success:var(--true-color-green,#7DC06C);--blue:var(--true-color-blue,#8DB8DA)}}*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;background:var(--bg);color:var(--text)}body{min-height:100vh;overflow-x:hidden;font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);font-size:var(--text-body-medium,14px);line-height:var(--leading-body-medium,20px)}button,input,select{font:inherit;color:inherit;min-height:30px;border:1px solid var(--border);border-radius:8px;background:var(--bg);padding:4px 8px}button{cursor:pointer;font-weight:var(--font-weight-semibold,600)}button:hover:not(:disabled),summary:hover{border-color:var(--focus);background:var(--surface)}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}button:disabled{opacity:.58;cursor:wait}.primary,.primary:hover:not(:disabled){background:var(--text);color:var(--bg);border-color:var(--text)}.primary:hover:not(:disabled){opacity:.88}.summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:4px}.app{max-width:760px;margin:auto;padding:6px 12px 24px}.filterbar{position:sticky;top:0;z-index:6;background:color-mix(in srgb,var(--bg) 96%,transparent);backdrop-filter:blur(10px);padding:2px 0 5px;border-bottom:1px solid var(--border)}.filter-disclosure>summary{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:3px 7px;border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:12px;font-weight:var(--font-weight-semibold,600);list-style:none}.filter-disclosure>summary::-webkit-details-marker,.action-menu>summary::-webkit-details-marker,.outcome>summary::-webkit-details-marker{display:none}.filter-disclosure:not([open])>.filters{display:none}.filters{display:grid;grid-template-columns:88px 105px minmax(120px,1fr) minmax(120px,1.2fr) auto;gap:5px;margin-top:5px}.field{min-width:0}.field label,.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}.field input,.field select{width:100%}.icon{width:16px;height:16px;display:inline-block;vertical-align:-3px;fill:none;stroke:currentColor;stroke-width:1.85;stroke-linecap:round;stroke-linejoin:round;flex:none}.filter-icon{width:14px;height:14px}.error{margin-top:6px;padding:7px 9px;border:1px solid var(--danger);border-radius:8px;background:var(--danger-soft);color:var(--text)}.error[hidden]{display:none}.summary{display:flex;gap:5px;overflow-x:auto;padding:5px 0 0;scrollbar-width:thin}.chip{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;border:1px solid var(--border);border-radius:999px;padding:2px 7px;color:var(--muted);font-size:12px}.chip b{color:var(--text);font-variant-numeric:tabular-nums}.section{margin-top:8px}.sectionhead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px}.sectionhead h2{display:inline-flex;align-items:center;gap:5px;font-size:12px;line-height:16px;text-transform:uppercase;letter-spacing:.075em;margin:0;color:var(--muted)}.sectionhead p{font-size:12px;color:var(--muted);margin:0}.count{font-variant-numeric:tabular-nums}.attention{border:1px solid color-mix(in srgb,var(--accent) 55%,var(--border));border-radius:var(--r);overflow:visible}.nav-note{display:flex;gap:6px;align-items:flex-start;margin:8px 0 0;padding:6px 8px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--muted);font-size:12px}.attention-empty,.empty{padding:12px;color:var(--muted);font-size:12px;background:var(--surface)}.taskrow{position:relative;display:grid;grid-template-columns:24px 18px minmax(0,1fr) auto;gap:6px;align-items:center;min-height:58px;padding:6px 8px;border-top:1px solid var(--border);background:var(--bg)}.attention .taskrow{min-height:64px}.taskrow:first-child{border-top:0}.status-icon{color:var(--muted);align-self:start;margin-top:3px}.status-icon.pending{color:var(--warn)}.status-icon.in_progress{color:var(--accent)}.status-icon.blocked{color:var(--danger)}.status-icon.done{color:var(--success)}.rowcopy{min-width:0}.attention .rowtitle,.attention .why{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;-webkit-line-clamp:1}.rowtitle{font-weight:var(--font-weight-semibold,600);overflow-wrap:anywhere}.meta,.why{font-size:12px;color:var(--muted);margin-top:1px;overflow-wrap:anywhere}.rowactions{display:flex;align-items:stretch;gap:4px}.session-link{display:grid;place-items:center;width:30px;height:30px;border:1px solid var(--border);border-radius:8px;color:var(--text);text-decoration:none}.session-link:hover{border-color:var(--focus);background:var(--surface)}.disclosure{display:grid;place-items:center;align-self:start;width:24px;height:28px;margin-top:-3px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--muted);cursor:pointer}.disclosure:hover:not(:disabled){color:var(--text)}.disclosure .icon{transform:rotate(-90deg);transition:transform .16s cubic-bezier(.2,.8,.2,1)}.disclosure[aria-expanded=true] .icon{transform:none}.disclosure[aria-expanded=true]{color:var(--text)}
.row-primary{display:inline-flex;align-items:center;gap:6px;border-radius:8px;font-size:12px;font-weight:var(--font-weight-semibold,600);min-height:30px;padding:3px 10px;white-space:nowrap}
.row-primary.start,.row-primary.start:hover:not(:disabled){background:var(--accent);border-color:var(--accent);color:var(--accent-text)}.row-primary.start:hover:not(:disabled){background:var(--accent-strong);border-color:var(--accent-strong)}
.row-primary.nav{background:var(--bg);border-color:var(--accent);color:var(--accent-strong)}.row-primary.nav:hover:not(:disabled){background:var(--raised);border-color:var(--accent);color:var(--text)}
.meta .state{font-weight:var(--font-weight-semibold,600)}.meta .state.pending{color:var(--warn)}.meta .state.in_progress{color:var(--accent-strong)}.meta .state.blocked{color:var(--danger)}.meta .state.done{color:var(--success)}
.link-button{min-height:0;padding:0 2px;margin-left:4px;border:0;background:none;color:inherit;font-size:12px;text-decoration:underline;text-underline-offset:2px}.link-button:hover:not(:disabled){background:none;border:0;text-decoration-thickness:2px}
.menu-label{padding:4px 8px 2px;color:var(--muted);font-size:12px;line-height:16px;font-weight:var(--font-weight-semibold,600)}.menu hr{border:0;border-top:1px solid var(--border);margin:4px 0}.nowrap{white-space:nowrap;font-variant-numeric:tabular-nums}
.row-feedback{font-size:12px;color:var(--muted);overflow-wrap:anywhere}.row-feedback:not(:empty){margin-top:3px}.row-feedback[data-kind=ok]{color:var(--success)}.row-feedback[data-kind=error]{color:var(--danger)}.action-menu{position:relative}.action-menu>summary{display:grid;place-items:center;width:30px;height:30px;border:1px solid var(--border);border-radius:8px;cursor:pointer;list-style:none;color:var(--muted)}.action-menu[open]>summary{border-color:var(--focus);color:var(--text);background:var(--surface)}.menu{position:absolute;z-index:10;right:0;top:34px;width:min(250px,calc(100vw - 28px));padding:5px;border:1px solid var(--border);border-radius:8px;background:var(--bg);box-shadow:0 8px 20px color-mix(in srgb,var(--text) 16%,transparent)}.action-menu:not([open])>.menu{display:none}.menu button,.menu a{display:flex;align-items:center;gap:7px;width:100%;min-height:30px;padding:4px 8px;border:0;border-radius:8px;background:var(--bg);color:var(--text);text-align:left;text-decoration:none;font-size:12px;font-weight:500}.menu button:hover:not(:disabled),.menu button:focus-visible{background:var(--raised);border:0}.task-detail{grid-column:3/-1;padding:5px 0 2px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}.task-detail[hidden]{display:none}.stack{display:grid;gap:7px}.outcome{border:1px solid var(--border);border-radius:var(--r);background:var(--surface);overflow:visible}.outcome>summary{list-style:none;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:8px 9px;cursor:pointer}.outcome-title{font-weight:var(--font-weight-semibold,600);overflow-wrap:anywhere}.outcome-meta{font-size:12px;color:var(--muted);margin-top:1px}.outcome-body{border-top:1px solid var(--border);overflow:visible}.more{width:100%;margin-top:7px}.footer-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}.panel{border:1px solid var(--border);border-radius:var(--r);padding:9px;background:var(--surface)}.panel h2{font-size:14px;margin:0 0 6px}.addform{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px}.addform select{grid-column:1/-1}.reportout{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;font:var(--text-code-inline,12px)/1.45 var(--font-mono,Consolas,monospace);color:var(--muted);margin:6px 0 0}.loading{padding:24px;text-align:center;color:var(--muted);border:1px dashed var(--border);border-radius:var(--r);margin-top:10px}@media(max-width:560px){.app{padding:5px 9px 24px}.filters{grid-template-columns:82px 96px minmax(0,1fr) auto}.workspace-field{grid-column:3}.search-field{grid-column:1/4}.footer-grid{grid-template-columns:1fr}}@media(max-width:419px){.taskrow{grid-template-columns:22px 17px minmax(0,1fr);gap:4px 5px;padding-inline:6px}.taskrow>.rowactions{grid-column:3;justify-self:start;position:relative}.taskrow .action-menu{position:static}.taskrow .menu{left:0;right:auto;width:min(250px,100%)}}
@media(max-width:419px){.taskrow>.rowactions{justify-self:stretch}}
@media(max-width:399px){.app{padding-inline:8px}.filterbar{padding-top:1px}.filters{grid-template-columns:1fr 1fr}.workspace-field,.search-field{grid-column:1/-1}#refresh{grid-column:2}.sectionhead p{display:none}.summary{padding-top:4px}.section{margin-top:7px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
.suggestions{display:grid;gap:6px}.suggestion{border:1px dashed var(--border);border-radius:8px;padding:6px 10px;background:var(--surface)}.suggestion .s-title{font-weight:var(--font-weight-semibold,600);overflow-wrap:anywhere}.suggestion .s-meta,.suggestion .s-sum{font-size:12px;color:var(--muted);overflow-wrap:anywhere}.s-badge{display:inline-block;font-size:11px;line-height:16px;padding:0 6px;margin-right:6px;border:1px solid var(--border);border-radius:999px;color:var(--muted);vertical-align:1px}.observe-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:6px}
</style></head><body><svg class="sr-only" aria-hidden="true"><symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4m0 3h.01"/></symbol><symbol id="i-play" viewBox="0 0 24 24"><path d="m8 5 11 7-11 7V5Z"/></symbol><symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol><symbol id="i-check" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></symbol><symbol id="i-blocked" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/></symbol><symbol id="i-chevron" viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></symbol><symbol id="i-more" viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="18" cy="12" r="1.1"/></symbol><symbol id="i-filter" viewBox="0 0 24 24"><path d="M4 6h16M7 12h10m-7 6h4"/></symbol><symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></symbol><symbol id="i-open" viewBox="0 0 24 24"><path d="M14 5h5v5m0-5-8 8"/><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></symbol><symbol id="i-session" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h6m-6 4h4m6-2v5m-2-2h4"/></symbol><symbol id="i-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></symbol><symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-9h.01"/></symbol></svg><main class="app"><div class="filterbar"><details id="filtersPanel" class="filter-disclosure" open><summary><svg class="icon filter-icon" aria-hidden="true"><use href="#i-filter"/></svg><span id="filterToggleLabel">Hide filters</span></summary><div class="filters"><div class="field"><label for="period">Period</label><select id="period" title="Period"><option value="today">Today</option><option value="week" selected>This week</option><option value="all">All time</option></select></div><div class="field"><label for="status">Status</label><select id="status" title="Status"><option value="all">All states</option><option value="pending">Pending</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="done">Done</option></select></div><div class="field workspace-field"><label for="project">Workspace</label><select id="project" title="Workspace"><option value="all">All workspaces</option></select></div><div class="field search-field"><label for="search">Search</label><input id="search" type="search" placeholder="Search work…" aria-label="Search work"></div><button id="refresh" class="primary">Refresh</button></div></details><div id="error" class="error" role="alert" hidden><strong>Taskbean needs attention.</strong> <span id="errorMessage"></span> <span id="errorHint"></span></div></div><div id="stats" class="summary" aria-label="Scoped counts"></div><div id="content"><div class="loading">Reading the local ledger…</div></div><section class="footer-grid"><div class="panel"><h2>Add task</h2><form id="addForm" class="addform"><input id="newTitle" placeholder="What needs doing?" aria-label="Task title" required><button type="submit">Add</button><select id="newProject" aria-label="Stored task project"><option value="">Current/default project</option></select></form></div><div class="panel"><h2>Weekly evidence</h2><button id="report">Generate report JSON</button><pre id="reportOut" class="reportout">No report generated.</pre></div></section></main>
<script>
let state=null,visibleLimit=8,filterTouched=false;const $=id=>document.getElementById(id);const esc=v=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
class DashboardActionError extends Error{constructor(d){super(d.message);this.code=d.code||"taskbean_dashboard_error";this.status=d.status||500;this.retryable=!!d.retryable}}
const icon=(name,label="")=>'<svg class="icon" '+(label?'role="img" aria-label="'+esc(label)+'"':'aria-hidden="true"')+'><use href="#i-'+name+'"/></svg>';
const statusIcon=t=>icon(t.status==="blocked"?"blocked":t.status==="in_progress"?"play":t.status==="done"?"check":"clock",t.statusLabel||t.status);
function filters(){return{period:$("period").value,status:$("status").value,project:$("project").value,search:$("search").value}}
async function api(action,input={}){const r=await fetch("/api/action",{method:"POST",headers:{"Content-Type":"application/json","X-Taskbean-Token":${JSON.stringify(token)}},body:JSON.stringify({action,input})});let p;try{p=await r.json()}catch{throw new Error("Taskbean returned an unreadable response.")}if(!r.ok||p.error){const e=p.error||{};throw new DashboardActionError({message:e.message||p.message||"Taskbean action failed.",code:e.code,status:e.status||r.status,retryable:e.retryable})}return p.result}
function setError(error){const el=$("error");if(!error){el.hidden=true;return}el.hidden=false;$("errorMessage").textContent=error.message||String(error);$("errorHint").textContent=error.retryable?" Try again; check the extension log if it persists.":" Check the input and refresh."}
function relative(value){if(!value)return"Date unavailable";const d=new Date(value);if(Number.isNaN(d.getTime()))return String(value);const seconds=Math.round((d-Date.now())/1000),abs=Math.abs(seconds);if(abs<45)return"just now";const units=[[31536000,"year"],[2592000,"month"],[604800,"week"],[86400,"day"],[3600,"hour"],[60,"minute"]];for(const [size,name] of units)if(abs>=size){const n=Math.round(seconds/size);return new Intl.RelativeTimeFormat(undefined,{numeric:"auto"}).format(n,name)}return"just now"}
${rowActions.toString()}
function actionSet(t){return rowActions(t,state.navigation)}
function actionButton(x,t,inMenu){const title=t.displayTitle||t.title||"task";const role=inMenu?' role="menuitem"':'';const cls=inMenu?'':' class="row-primary '+esc(x.style||"")+'"';const text=esc(x.label);if(x.kind==="open")return '<button type="button"'+cls+role+' data-open-link="'+esc(x.target)+'" data-task-id="'+esc(t.id)+'"'+(x.sessionId?' data-session-id="'+esc(x.sessionId)+'"':'')+' aria-label="'+esc(x.ariaLabel+", "+title)+'" title="'+esc(x.help)+'">'+icon(x.icon)+text+'</button>';if(x.kind==="copy")return '<button type="button"'+cls+role+' '+(x.copy==="session"?'data-copy-session':'data-copy-task')+'="'+esc(x.value)+'"'+(x.ariaLabel?' aria-label="'+esc(x.ariaLabel)+'"':'')+' title="'+esc(x.help)+'">'+icon(x.icon)+text+'</button>';return '<button type="button"'+cls+role+' data-action="'+esc(x.action)+'" data-id="'+esc(t.id)+'" aria-label="'+esc(x.label+", "+title)+'" title="'+esc(x.help)+'">'+icon(x.icon)+text+'</button>'}
function menuItems(items,t){const status=items.filter(x=>x.group==="status"),links=items.filter(x=>x.group!=="status");return (status.length?'<div role="group" aria-label="Change status"><div class="menu-label" aria-hidden="true">Change status</div>'+status.map(x=>actionButton(x,t,true)).join("")+'</div>':'')+(status.length&&links.length?'<hr role="separator">':'')+links.map(x=>actionButton(x,t,true)).join("")}
function row(t,attention=false){const stamp=t.updated_at||t.completed_at||t.created_at||t.due_date;const origin=t.origin||{};const title=t.displayTitle||t.title;const bits=[origin.label,relative(stamp)].filter(Boolean).join(" · ");const reason=attention&&t.needsYou?.detail?t.needsYou.detail:bits;const stateText='<span class="state '+esc(t.status)+'">'+esc(t.statusLabel||t.status)+'</span> · ';const details=[[t.statusLabel,origin.label].filter(Boolean).join(" · "),origin.detail,!origin.detail&&origin.path?origin.path:"",origin.session?.id?"Copilot session: "+(origin.session.name||origin.session.id):"",t.notes?"Notes: "+t.notes:"",t.agent?"Agent: "+t.agent:"",t.due_date?"Due: "+t.due_date:"",t.pullRequest?"Pull request: "+t.pullRequest.repo+" #"+t.pullRequest.number+(t.pullRequest.state?" · "+t.pullRequest.state:""):"",...(Array.isArray(t.tags)?t.tags.map(x=>"Tag: "+x):[])].filter(Boolean).join(" · ")||"No additional evidence is recorded.";const a=actionSet(t),detailId="detail-"+(attention?"a-":"")+String(t.id).replace(/[^A-Za-z0-9_-]/g,"-");const toggle='<button type="button" class="disclosure" data-disclosure aria-expanded="false" aria-controls="'+detailId+'" aria-label="Show details for '+esc(title)+'" title="Show details">'+icon("chevron")+'</button>';const primary=a.primary?actionButton(a.primary,t,false):"";const menu=a.secondary.length?'<details class="action-menu"><summary aria-label="More actions for '+esc(title)+'" aria-haspopup="menu" title="More actions">'+icon("more")+'</summary><div class="menu" role="menu" aria-label="Actions for '+esc(title)+'">'+menuItems(a.secondary,t)+'</div></details>':"";const actions=primary||menu?'<div class="rowactions">'+primary+menu+'</div>':"";return '<article class="taskrow'+(attention?' attentionrow':'')+'">'+toggle+icon(t.status==="blocked"?"blocked":t.status==="in_progress"?"play":t.status==="done"?"check":"clock").replace('class="icon"','class="icon status-icon '+esc(t.status)+'"')+'<div class="rowcopy"><div class="rowtitle">'+esc(title)+'</div><div class="'+(attention?'why':'meta')+'">'+(attention?'':stateText)+esc(reason)+'</div><div class="row-feedback" role="status" aria-live="polite"></div></div>'+actions+'<div class="task-detail" id="'+detailId+'" hidden>'+esc(details)+'</div></article>'}
function renderProjects(){const prev=$("project").value,add=$("newProject").value;$("project").innerHTML='<option value="all">All workspaces · '+(state.workspaceTaskCount??0)+'</option>'+state.workspaces.map(w=>'<option value="'+esc(w.key)+'">'+esc(w.displayLabel||w.label)+' · '+w.count+'</option>').join("");$("newProject").innerHTML='<option value="">Current/default project</option>'+state.projects.map(p=>'<option value="'+esc(p.name)+'">'+esc(p.name)+'</option>').join("");$("project").value=[...$("project").options].some(o=>o.value===prev)?prev:"all";$("newProject").value=[...$("newProject").options].some(o=>o.value===add)?add:""}
function renderStats(){const s=state.summary||{},b=s.byStatus||{};const items=[["info","In view",s.total||0],["alert","Needs you",state.needsYou.length],["play","In progress",b.in_progress||0],["blocked","Blocked",b.blocked||0],["check","Done",b.done||0]];$("stats").innerHTML=items.map(x=>'<span class="chip">'+icon(x[0])+'<b>'+x[2]+'</b> '+x[1]+'</span>').join("")}
function renderContent(){const attention=state.needsYou||[],groups=state.outcomeGroups||[];let used=0;const rendered=[];const navOk=state.navigation?.sessions?.available!==false,navWhy=state.navigation?.sessions?.reason||"Opening Copilot sessions is unavailable here.";for(const g of groups){if(used>=visibleLimit)break;const initiallyOpen=g.needsYou>0&&g.tasks.some(t=>t.status!=="done");const eligible=initiallyOpen?g.tasks.filter(t=>t.status!=="done"):g.tasks;const take=eligible.slice(0,visibleLimit-used);used+=take.length;const doneCount=g.tasks.filter(t=>t.status==="done").length;const groupLabel=(g.sessionName?"Open Copilot session "+g.sessionName:"Open Copilot session")+" for "+g.label;const groupSession=g.sessionId?(navOk?'<button type="button" class="session-link" data-open-link="session" data-session-id="'+esc(g.sessionId)+'" aria-label="'+esc(groupLabel)+'" title="Opens the Copilot session. Does not change tasks.">'+icon("session")+'</button>':'<button type="button" class="session-link" data-copy-session="'+esc(g.sessionId)+'" aria-label="'+esc("Copy session ID for "+g.label+". Opening sessions is unavailable: "+navWhy)+'" title="'+esc("Opening sessions is unavailable: "+navWhy+" Copies the session ID.")+'">'+icon("copy")+'</button>'):"";rendered.push('<details class="outcome" '+(initiallyOpen?'open':'')+'><summary><div><div class="outcome-title">'+esc(g.label)+'</div><div class="outcome-meta"><span class="nowrap">'+g.tasks.length+' '+(g.tasks.length===1?'item':'items')+'</span>'+(doneCount?' · <span class="nowrap">'+doneCount+' done</span>':'')+(g.needsYou?' · <span class="nowrap">'+g.needsYou+' needs you</span>':'')+'</div><div class="row-feedback group-feedback" role="status" aria-live="polite"></div></div><div class="rowactions">'+groupSession+icon("chevron")+'</div></summary><div class="outcome-body">'+take.map(t=>row(t)).join("")+'</div></details>')}const remaining=Math.max(0,(state.tasks||[]).length-used);$("content").innerHTML=(navOk?'':'<p class="nav-note" role="note">'+icon("info")+esc("Session buttons copy the session ID: "+navWhy)+'</p>')+'<section class="section"><div class="sectionhead"><h2>'+icon("alert")+'Needs you</h2><p>Blocked or explicitly tagged evidence only · <span class="count">'+attention.length+'</span></p></div><div class="attention">'+(attention.length?attention.slice(0,2).map(t=>row(t,true)).join(""):'<div class="attention-empty">No recorded blockers, HITL gates, or approval tags in this view.</div>')+'</div></section><section class="section"><div class="sectionhead"><h2>'+icon("open")+'Outcome stack</h2><p>Explicit outcomes lead; reliable product and repository evidence forms provisional Workstreams.</p></div><div class="stack">'+(rendered.join("")||'<div class="empty">No tasks match this scope.</div>')+'</div>'+(remaining?'<button id="more" class="more">Show '+Math.min(12,remaining)+' more · '+remaining+' remaining</button>':'')+'</section>'+renderSuggestions();if($("more"))$("more").onclick=()=>{visibleLimit+=12;renderContent()};if($("observe"))$("observe").onclick=observeEvidence}
function renderSuggestions(){const s=state.suggestedEvidence||{available:false,items:[],count:0,reason:"Suggestions are unavailable."};const items=s.items||[];const list=!s.available?'<div class="attention-empty">'+esc("Suggestions are unavailable: "+(s.reason||"unknown error"))+'</div>':items.length?items.map(x=>'<div class="suggestion"><div class="s-title"><span class="s-badge">Suggestion</span>'+esc(x.title)+'</div><div class="s-meta">'+esc([x.project,relative(x.occurred_at),Math.round((x.confidence||0)*100)+"% confidence"].filter(Boolean).join(" · "))+'</div>'+(x.summary?'<div class="s-sum">'+esc(x.summary)+'</div>':'')+'</div>').join(""):'<div class="attention-empty">No pending suggestions. Collect evidence to look for recent session work.</div>';return '<section class="section" aria-labelledby="suggestionsHead"><div class="sectionhead"><h2 id="suggestionsHead">'+icon("info")+'Suggested evidence</h2><p>Not accepted outcomes · <span class="count">'+(s.count||0)+'</span> pending review</p></div><div class="observe-bar"><button type="button" id="observe" title="Reads local Copilot session metadata only. Does not create, link, or change tasks.">Collect evidence (observe only)</button><span id="observeFeedback" class="row-feedback" role="status" aria-live="polite"></span></div><div class="suggestions">'+list+'</div>'+(s.count>items.length?'<p class="s-meta">Showing '+items.length+' of '+s.count+'. Review all with <code>bean chronicle suggestions</code>.</p>':(items.length?'<p class="s-meta">Approve, link, or ignore with <code>bean chronicle</code>. The canvas never accepts suggestions for you.</p>':''))+'</section>'}
async function observeEvidence(){const b=$("observe"),fb=$("observeFeedback");b.disabled=true;b.setAttribute("aria-busy","true");feedback(fb,"Reading session metadata…","pending");try{const r=await api("observe_evidence",{});if(!r.available){feedback(fb,"Session evidence is unavailable: "+(r.reason||"unknown reason")+". No tasks changed.","error");return}const c=r.counts||{};const msg="Observed "+(c.discovered||0)+" sessions · "+(c.created||0)+" new, "+(c.updated||0)+" updated suggestions. No tasks changed."+(r.has_more?" More remain; collect again.":"");state=await api("get_dashboard",filters());render();feedback($("observeFeedback"),msg,"ok")}catch(e){feedback($("observeFeedback"),(e.message||"Could not collect evidence.")+" No tasks changed.","error")}finally{const nb=$("observe");if(nb){nb.disabled=false;nb.removeAttribute("aria-busy")}}}
function render(){renderProjects();renderStats();renderContent()}
async function refresh(){$("refresh").disabled=true;setError(null);try{state=await api("get_dashboard",filters());visibleLimit=8;render()}catch(e){setError(e)}finally{$("refresh").disabled=false}}
function syncFilters(){const d=$("filtersPanel");if(!filterTouched)d.open=matchMedia("(min-width:400px)").matches;$("filterToggleLabel").textContent=d.open?"Hide filters":"Filters"}syncFilters();$("filtersPanel").addEventListener("toggle",()=>{$("filterToggleLabel").textContent=$("filtersPanel").open?"Hide filters":"Filters"});$("filtersPanel").querySelector("summary").addEventListener("click",()=>{filterTouched=true});addEventListener("resize",syncFilters);
function feedback(el,text,kind,copySession){if(!el)return;el.setAttribute("role",kind==="error"?"alert":"status");el.textContent=text;if(copySession){const b=document.createElement("button");b.type="button";b.className="link-button";b.dataset.copySession=copySession;b.textContent="Copy session ID";el.append(" ",b)}el.dataset.kind=kind;clearTimeout(el.__timer);if(kind==="ok")el.__timer=setTimeout(()=>{el.textContent="";delete el.dataset.kind},2400)}
function feedbackFor(b){return b.closest(".taskrow")?.querySelector(".row-feedback")||b.closest(".outcome")?.querySelector(".group-feedback")}
function closeMenu(b){const m=b.closest(".action-menu");if(m){m.open=false;m.querySelector("summary")?.focus()}}
async function copyText(value){if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);return}const area=document.createElement("textarea");area.value=value;area.setAttribute("readonly","");area.style.position="fixed";area.style.opacity="0";document.body.append(area);area.select();const ok=document.execCommand("copy");area.remove();if(!ok)throw new Error("Copy failed")}
async function copyId(button){const session=button.dataset.copySession,task=button.dataset.copyTask;const value=session||task;const fb=feedbackFor(button);closeMenu(button);if(session&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(session))return;if(!value)return;const what=session?"Session ID":"Task ID";try{await copyText(value);feedback(fb,what+" copied.","ok")}catch{feedback(fb,"Could not copy the "+what.toLowerCase()+". Open the details to read it.","error")}}
async function openLink(b){const fb=feedbackFor(b);closeMenu(b);const input={target:b.dataset.openLink};if(b.dataset.taskId)input.taskId=b.dataset.taskId;if(b.dataset.sessionId)input.sessionId=b.dataset.sessionId;b.disabled=true;b.setAttribute("aria-busy","true");feedback(fb,"Starting link launcher…","pending");try{const result=await api("open_link",input);if(result.launcherStarted!==true)throw new Error("The link launcher did not start.");feedback(fb,input.target==="session"?"Link launcher started. Confirm the session opened in the Copilot app. Task status unchanged.":"Link launcher started. Confirm the pull request opened in your browser. Task status unchanged.","ok")}catch(x){feedback(fb,(x.message||"Could not start the link launcher.")+(x.retryable?" Try again.":""),"error",input.target==="session"?input.sessionId:"")}finally{b.disabled=false;b.removeAttribute("aria-busy")}}
function toggleDetails(b){const d=$(b.getAttribute("aria-controls"));if(!d)return;d.hidden=!d.hidden;b.setAttribute("aria-expanded",String(!d.hidden));const title=b.getAttribute("aria-label").replace(/^(Show|Hide) details for /,"");b.setAttribute("aria-label",(d.hidden?"Show":"Hide")+" details for "+title);b.title=d.hidden?"Show details":"Hide details"}
$("refresh").onclick=refresh;["period","status","project"].forEach(id=>$(id).onchange=refresh);$("search").oninput=()=>{clearTimeout(window.__searchTimer);window.__searchTimer=setTimeout(refresh,250)};$("content").onclick=async e=>{const disclosure=e.target.closest("button[data-disclosure]");if(disclosure){toggleDetails(disclosure);return}const open=e.target.closest("button[data-open-link]");if(open){e.preventDefault();e.stopPropagation();if(!open.disabled)await openLink(open);return}const copy=e.target.closest("button[data-copy-session],button[data-copy-task]");if(copy){e.preventDefault();e.stopPropagation();await copyId(copy);return}const b=e.target.closest("button[data-action]");if(!b)return;closeMenu(b);const message=(b.dataset.action==="start_task"?"Mark this Taskbean item in progress?":b.dataset.action==="complete_task"?"Mark this Taskbean item complete?":"Mark this Taskbean item blocked?")+" This updates the local ledger.";if(!confirm(message))return;b.disabled=true;setError(null);try{await api(b.dataset.action,{id:b.dataset.id});await refresh()}catch(x){setError(x)}finally{b.disabled=false}};document.addEventListener("click",e=>{document.querySelectorAll(".action-menu[open]").forEach(d=>{if(!d.contains(e.target))d.open=false})});document.addEventListener("pointerdown",e=>{const m=e.target.closest?.(".action-menu");if(m)m.__pointer=true},true);document.addEventListener("toggle",e=>{const d=e.target;if(!d.matches?.(".action-menu"))return;if(d.open){document.querySelectorAll(".action-menu[open]").forEach(x=>{if(x!==d)x.open=false});if(!d.__pointer)d.querySelector(".menu [role=menuitem]")?.focus()}d.__pointer=false},true);document.addEventListener("focusout",e=>{const d=e.target.closest?.(".action-menu");if(d?.open&&e.relatedTarget&&!d.contains(e.relatedTarget))d.open=false});document.addEventListener("keydown",e=>{const d=e.target.closest?.(".action-menu");if(!d)return;if(d.open&&["Home","End"].includes(e.key)){const items=[...d.querySelectorAll(".menu [role=menuitem]")];items[e.key==="Home"?0:items.length-1]?.focus();e.preventDefault()}if(e.key==="Escape"){d.open=false;d.querySelector("summary").focus();e.preventDefault()}if(["ArrowDown","ArrowUp"].includes(e.key)){const items=[...d.querySelectorAll(".menu [role=menuitem]")];if(!items.length)return;const i=items.indexOf(document.activeElement),next=e.key==="ArrowDown"?(i+1)%items.length:(i-1+items.length)%items.length;items[next].focus();e.preventDefault()}});$("addForm").onsubmit=async e=>{e.preventDefault();setError(null);try{await api("add_task",{title:$("newTitle").value,project:$("newProject").value||undefined});$("newTitle").value="";await refresh()}catch(x){setError(x)}};$("report").onclick=async()=>{const b=$("report");b.disabled=true;setError(null);try{$("reportOut").textContent=JSON.stringify(await api("generate_report",{period:$("period").value==="all"?"week":$("period").value}),null,2)}catch(x){setError(x)}finally{b.disabled=false}};refresh();
</script></body></html>`;
}

async function startServer(instanceId) {
    const token = randomBytes(32).toString("hex");
    let origin;
    const deny = (res, status, code, message) => sendJson(res, status, {
        error: { code, message, status, retryable: false },
    });
    const server = createServer(async (req, res) => {
        try {
            res.setHeader("Referrer-Policy", "no-referrer");
            res.setHeader("X-Content-Type-Options", "nosniff");
            if (req.headers.host !== new URL(origin).host) {
                deny(res, 403, "taskbean_request_forbidden", "Requests must come from this Taskbean canvas.");
                return;
            }
            const url = new URL(req.url || "/", origin);
            if (url.pathname === "/api/action" &&
                ((req.headers.origin !== undefined && req.headers.origin !== origin) ||
                    req.headers["sec-fetch-site"] === "cross-site")) {
                deny(res, 403, "taskbean_request_forbidden", "Requests must come from this Taskbean canvas.");
                return;
            }
            if (req.method === "GET" && url.pathname === "/") {
                if (url.searchParams.get("token") !== token) {
                    deny(res, 403, "taskbean_request_forbidden", "Reopen the Taskbean canvas to authorize this view.");
                    return;
                }
                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store",
                });
                res.end(renderHtml(token));
                return;
            }

            if (req.method === "POST" && url.pathname === "/api/action") {
                if (req.headers["x-taskbean-token"] !== token) {
                    deny(res, 403, "taskbean_request_forbidden", "Reopen the Taskbean canvas to authorize this request.");
                    return;
                }
                if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers["content-type"] || "")) {
                    deny(res, 415, "taskbean_json_required", "Taskbean actions require application/json.");
                    return;
                }
                const body = await parseJsonBody(req);
                const result = await routeApi(body.action, body.input || {});
                sendJson(res, 200, { result });
                return;
            }

            sendJson(res, 404, { error: "not_found" });
        } catch (error) {
            await logError("HTTP request", error);
            const safe = sanitizeError(error);
            sendJson(res, safe.status, { error: safe });
        }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    origin = `http://127.0.0.1:${port}`;
    return { server, url: `${origin}/?token=${token}` };
}

function action(name, description, inputSchema, handler) {
    return { name, description, inputSchema, handler };
}

function safeAction(name, description, inputSchema, handler) {
    return action(name, description, inputSchema, (ctx) => withSafeErrors(`canvas action ${name}`, () => handler(ctx)));
}

async function getAvailability(ctx) {
    return {
        ...describeAvailability({ extensionId: ctx.extensionId, canvasId: ctx.canvasId, extensionFile: EXTENSION_FILE }),
        navigation: await navigationSupport(linkLauncherOptions()),
    };
}

const dashboardCanvas = createCanvas({
    id: "taskbean-dashboard",
    displayName: "Taskbean Dashboard",
    description: "Personal cross-workspace Taskbean board for viewing, adding, starting, blocking, completing, and reporting tasks.",
    inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
            period: { type: "string", enum: ["today", "week", "all"] },
            status: { type: "string", enum: ["all", ...STATUS_ORDER] },
            project: { type: "string" },
            search: { type: "string" },
        },
    },
    actions: [
        safeAction("get_availability", "Report how this Taskbean Dashboard extension is installed and scoped.", {
            type: "object",
            additionalProperties: false,
            properties: {},
        }, getAvailability),
        safeAction("get_dashboard", "Return the current task dashboard model.", {
            type: "object",
            additionalProperties: false,
            properties: {
                period: { type: "string", enum: ["today", "week", "all"] },
                status: { type: "string", enum: ["all", ...STATUS_ORDER] },
                project: { type: "string" },
                search: { type: "string" },
            },
        }, (ctx) => loadDashboard(ctx.input || {})),
        safeAction("add_task", "Create a new taskbean task.", {
            type: "object",
            additionalProperties: false,
            required: ["title"],
            properties: {
                title: { type: "string" },
                project: { type: "string" },
                key: { type: "string" },
            },
        }, (ctx) => addTask(ctx.input || {})),
        safeAction("start_task", "Mark a task as in progress.", {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: { id: { type: "string" } },
        }, (ctx) => mutateTask("start_task", ctx.input || {})),
        safeAction("complete_task", "Mark a task as done.", {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: { id: { type: "string" } },
        }, (ctx) => mutateTask("complete_task", ctx.input || {})),
        safeAction("block_task", "Mark a task as blocked.", {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: { id: { type: "string" } },
        }, (ctx) => mutateTask("block_task", ctx.input || {})),
        safeAction("open_link", "Start the system link launcher for a task's trusted Copilot session or HTTPS pull request. Launcher start does not confirm navigation. Re-resolves the target from the Taskbean ledger; never accepts a URL or changes the task.", {
            type: "object",
            additionalProperties: false,
            required: ["target"],
            properties: {
                target: { type: "string", enum: ["session", "pull_request"] },
                taskId: { type: "string" },
                sessionId: { type: "string" },
            },
        }, (ctx) => openLink(ctx.input || {})),
        safeAction("observe_evidence", "Collect observe-only evidence suggestions from local Copilot session metadata. Never creates, links, completes, or edits tasks; results stay pending for review.", {
            type: "object",
            additionalProperties: false,
            properties: {},
        }, () => observeEvidence()),
        safeAction("generate_report", "Generate a taskbean report JSON payload.", {
            type: "object",
            additionalProperties: false,
            properties: {
                period: { type: "string", enum: ["today", "week", "all"] },
            },
        }, (ctx) => generateReport(ctx.input || {})),
    ],
    open: async (ctx) => {
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
            entry = await startServer(ctx.instanceId);
            servers.set(ctx.instanceId, entry);
        }
        return {
            title: "Taskbean Dashboard",
            status: "Connected to local taskbean",
            url: entry.url,
        };
    },
    onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
            servers.delete(ctx.instanceId);
            await new Promise((resolve) => entry.server.close(() => resolve()));
        }
    },
});

session = await joinSession({
    canvases: [dashboardCanvas],
    hooks: {
        onSessionStart: async () => ({
            additionalContext: "The Taskbean Dashboard canvas is available. Use it when the user asks to view, manage, or report on Taskbean tasks across workspaces. Its observe_evidence action only collects pending suggestions; approving, linking, or ignoring them stays in the Taskbean CLI review flow.",
        }),
    },
});

await session.log("Taskbean Dashboard canvas extension loaded.", { level: "info", ephemeral: true });
