import { createServer } from "node:http";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { resolveTrustedCopilotSession, resolveTrustedPullRequest, sessionDeepLink } from "./session-links.mjs";
import { getAvailability as describeAvailability } from "./availability.mjs";
import { BeanCommandError, runBean } from "./bean-runner.mjs";

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
        label: name || "Copilot session",
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

async function loadDashboard(input = {}) {
    const filters = {
        period: PERIODS.has(input.period) ? input.period : "week",
        status: input.status || "all",
        project: input.project || "all",
        search: input.search || "",
    };

    const [rawTasks, projects] = await Promise.all([
        beanJson(["list", "--all", "--json"]),
        beanJson(["projects", "--all", "--json"]),
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

async function routeApi(action, input) {
    if (action === "get_dashboard") return loadDashboard(input);
    if (action === "generate_report") return generateReport(input);
    if (action === "add_task") return addTask(input);
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

function renderHtml() {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="icon" href="data:,"><title>Taskbean Dashboard</title>
<style>
:root{color-scheme:light dark;--bg:var(--background-color-default,#fff);--surface:var(--background-color-muted,#f6f8fa);--raised:var(--background-color-emphasis,#fff);--border:var(--border-color-default,#d0d7de);--text:var(--text-color-default,#1f2328);--muted:var(--text-color-muted,#656d76);--focus:var(--color-focus-outline,#0969da);--accent:var(--true-color-orange,#bf5b16);--danger:var(--true-color-red,#cf222e);--danger-soft:var(--true-color-red-muted,#ffebe9);--success:var(--true-color-green,#1a7f37);--blue:var(--true-color-blue,#0969da);--r:10px}*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text)}body{min-height:100vh;overflow-x:hidden;font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);font-size:var(--text-body-medium,14px);line-height:var(--leading-body-medium,20px)}button,input,select{font:inherit;color:inherit;min-height:30px;border:1px solid var(--border);border-radius:8px;background:var(--bg);padding:4px 8px}button{cursor:pointer;font-weight:var(--font-weight-semibold,600)}button:hover:not(:disabled),summary:hover{border-color:var(--focus);background:var(--surface)}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}button:disabled{opacity:.58;cursor:wait}.primary{background:var(--text);color:var(--bg);border-color:var(--text)}.app{max-width:760px;margin:auto;padding:6px 12px 24px}.filterbar{position:sticky;top:0;z-index:6;background:color-mix(in srgb,var(--bg) 96%,transparent);backdrop-filter:blur(10px);padding:2px 0 5px;border-bottom:1px solid var(--border)}.filter-disclosure>summary{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:3px 7px;border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:12px;font-weight:var(--font-weight-semibold,600);list-style:none}.filter-disclosure>summary::-webkit-details-marker,.action-menu>summary::-webkit-details-marker,.outcome>summary::-webkit-details-marker{display:none}.filter-disclosure:not([open])>.filters{display:none}.filters{display:grid;grid-template-columns:88px 105px minmax(120px,1fr) minmax(120px,1.2fr) auto;gap:5px;margin-top:5px}.field{min-width:0}.field label,.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}.field input,.field select{width:100%}.icon{width:16px;height:16px;display:inline-block;vertical-align:-3px;fill:none;stroke:currentColor;stroke-width:1.85;stroke-linecap:round;stroke-linejoin:round;flex:none}.filter-icon{width:14px;height:14px}.error{margin-top:6px;padding:7px 9px;border:1px solid var(--danger);border-radius:8px;background:var(--danger-soft);color:var(--text)}.error[hidden]{display:none}.summary{display:flex;gap:5px;overflow-x:auto;padding:5px 0 0;scrollbar-width:thin}.chip{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;border:1px solid var(--border);border-radius:999px;padding:2px 7px;color:var(--muted);font-size:12px}.chip b{color:var(--text);font-variant-numeric:tabular-nums}.section{margin-top:8px}.sectionhead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px}.sectionhead h2{display:inline-flex;align-items:center;gap:5px;font-size:12px;line-height:16px;text-transform:uppercase;letter-spacing:.075em;margin:0;color:var(--muted)}.sectionhead p{font-size:12px;color:var(--muted);margin:0}.count{font-variant-numeric:tabular-nums}.attention{border:1px solid color-mix(in srgb,var(--accent) 55%,var(--border));border-radius:var(--r);overflow:visible}.attention-empty,.empty{padding:12px;color:var(--muted);font-size:12px;background:var(--surface)}.taskrow{position:relative;display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:7px;align-items:center;min-height:58px;padding:6px 8px;border-top:1px solid var(--border);background:var(--bg)}.attention .taskrow{min-height:64px;max-height:84px}.taskrow:first-child{border-top:0}.status-icon{color:var(--muted);align-self:start;margin-top:3px}.status-icon.pending{color:var(--accent)}.status-icon.in_progress{color:var(--blue)}.status-icon.blocked{color:var(--danger)}.status-icon.done{color:var(--success)}.rowcopy{min-width:0}.attention .rowtitle,.attention .why{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;-webkit-line-clamp:1}.rowtitle{font-weight:var(--font-weight-semibold,600);overflow-wrap:anywhere}.meta,.why{font-size:12px;color:var(--muted);margin-top:1px;overflow-wrap:anywhere}.rowactions{display:flex;align-items:stretch;gap:4px}.session-link{display:grid;place-items:center;width:30px;height:30px;border:1px solid var(--border);border-radius:8px;color:var(--text);text-decoration:none}.session-link:hover{border-color:var(--focus);background:var(--surface)}.split-primary{display:inline-flex;align-items:center;gap:4px;border-radius:8px 0 0 8px;font-size:12px;min-height:30px;padding:3px 7px;white-space:nowrap}.action-menu{position:relative}.action-menu>summary{display:grid;place-items:center;width:28px;height:30px;border:1px solid var(--border);border-left:0;border-radius:0 8px 8px 0;cursor:pointer;list-style:none;color:var(--muted)}.action-menu[open]>summary{border-color:var(--focus);color:var(--text);background:var(--surface)}.menu{position:absolute;z-index:10;right:0;top:34px;width:min(250px,calc(100vw - 28px));padding:5px;border:1px solid var(--border);border-radius:8px;background:var(--bg);box-shadow:0 8px 20px color-mix(in srgb,var(--text) 16%,transparent)}.action-menu:not([open])>.menu{display:none}.menu-label{padding:3px 6px 5px;color:var(--muted);font-size:12px}.menu button,.menu a{display:flex;align-items:center;gap:7px;width:100%;min-height:30px;padding:4px 8px;border:0;border-radius:8px;background:var(--bg);color:var(--text);text-align:left;text-decoration:none;font-size:12px;font-weight:500}.menu a:hover{background:var(--surface)}.task-detail{grid-column:2/-1;padding:5px 0 2px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}.detail-tools{display:flex;align-items:center;flex-wrap:wrap;gap:5px;min-height:30px;margin-top:5px}.detail-link,.copy-session{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:3px 7px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);text-decoration:none;font-size:12px;font-weight:var(--font-weight-semibold,600)}.copy-feedback{display:inline-block;min-width:42px;color:var(--success);font-size:12px}.task-detail[hidden]{display:none}.stack{display:grid;gap:7px}.outcome{border:1px solid var(--border);border-radius:var(--r);background:var(--surface);overflow:visible}.outcome>summary{list-style:none;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:8px 9px;cursor:pointer}.outcome-title{font-weight:var(--font-weight-semibold,600);overflow-wrap:anywhere}.outcome-meta{font-size:12px;color:var(--muted);margin-top:1px}.outcome-body{border-top:1px solid var(--border);overflow:visible}.more{width:100%;margin-top:7px}.footer-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}.panel{border:1px solid var(--border);border-radius:var(--r);padding:9px;background:var(--surface)}.panel h2{font-size:14px;margin:0 0 6px}.addform{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px}.addform select{grid-column:1/-1}.reportout{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;font:var(--text-code-inline,12px)/1.45 var(--font-mono,Consolas,monospace);color:var(--muted);margin:6px 0 0}.loading{padding:24px;text-align:center;color:var(--muted);border:1px dashed var(--border);border-radius:var(--r);margin-top:10px}@media(max-width:560px){.app{padding:5px 9px 24px}.filters{grid-template-columns:82px 96px minmax(0,1fr) auto}.workspace-field{grid-column:3}.search-field{grid-column:1/4}.footer-grid{grid-template-columns:1fr}}@media(max-width:399px){.app{padding-inline:8px}.filterbar{padding-top:1px}.filters{grid-template-columns:1fr 1fr}.workspace-field,.search-field{grid-column:1/-1}#refresh{grid-column:2}.sectionhead p{display:none}.taskrow{grid-template-columns:17px minmax(0,1fr) auto;gap:5px;padding-inline:6px}.split-primary{padding-inline:6px}.primary-text-wide{display:none}.summary{padding-top:4px}.section{margin-top:7px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style></head><body><svg class="sr-only" aria-hidden="true"><symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4m0 3h.01"/></symbol><symbol id="i-play" viewBox="0 0 24 24"><path d="m8 5 11 7-11 7V5Z"/></symbol><symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol><symbol id="i-check" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></symbol><symbol id="i-blocked" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/></symbol><symbol id="i-chevron" viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></symbol><symbol id="i-filter" viewBox="0 0 24 24"><path d="M4 6h16M7 12h10m-7 6h4"/></symbol><symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></symbol><symbol id="i-open" viewBox="0 0 24 24"><path d="M14 5h5v5m0-5-8 8"/><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></symbol><symbol id="i-session" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h6m-6 4h4m6-2v5m-2-2h4"/></symbol><symbol id="i-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></symbol><symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-9h.01"/></symbol></svg><main class="app"><div class="filterbar"><details id="filtersPanel" class="filter-disclosure" open><summary><svg class="icon filter-icon" aria-hidden="true"><use href="#i-filter"/></svg><span id="filterToggleLabel">Hide filters</span></summary><div class="filters"><div class="field"><label for="period">Period</label><select id="period" title="Period"><option value="today">Today</option><option value="week" selected>This week</option><option value="all">All time</option></select></div><div class="field"><label for="status">Status</label><select id="status" title="Status"><option value="all">All states</option><option value="pending">Pending</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="done">Done</option></select></div><div class="field workspace-field"><label for="project">Workspace</label><select id="project" title="Workspace"><option value="all">All workspaces</option></select></div><div class="field search-field"><label for="search">Search</label><input id="search" type="search" placeholder="Search work…" aria-label="Search work"></div><button id="refresh" class="primary">Refresh</button></div></details><div id="error" class="error" role="alert" hidden><strong>Taskbean needs attention.</strong> <span id="errorMessage"></span> <span id="errorHint"></span></div></div><div id="stats" class="summary" aria-label="Scoped counts"></div><div id="content"><div class="loading">Reading the local ledger…</div></div><section class="footer-grid"><div class="panel"><h2>Add task</h2><form id="addForm" class="addform"><input id="newTitle" placeholder="What needs doing?" aria-label="Task title" required><button type="submit">Add</button><select id="newProject" aria-label="Stored task project"><option value="">Current/default project</option></select></form></div><div class="panel"><h2>Weekly evidence</h2><button id="report">Generate report JSON</button><pre id="reportOut" class="reportout">No report generated.</pre></div></section></main>
<script>
let state=null,visibleLimit=8,filterTouched=false;const $=id=>document.getElementById(id);const esc=v=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
class DashboardActionError extends Error{constructor(d){super(d.message);this.code=d.code||"taskbean_dashboard_error";this.status=d.status||500;this.retryable=!!d.retryable}}
const icon=(name,label="")=>'<svg class="icon" '+(label?'role="img" aria-label="'+esc(label)+'"':'aria-hidden="true"')+'><use href="#i-'+name+'"/></svg>';
const statusIcon=t=>icon(t.status==="blocked"?"blocked":t.status==="in_progress"?"play":t.status==="done"?"check":"clock",t.statusLabel||t.status);
function filters(){return{period:$("period").value,status:$("status").value,project:$("project").value,search:$("search").value}}
async function api(action,input={}){const r=await fetch("/api/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,input})});let p;try{p=await r.json()}catch{throw new Error("Taskbean returned an unreadable response.")}if(!r.ok||p.error){const e=p.error||{};throw new DashboardActionError({message:e.message||p.message||"Taskbean action failed.",code:e.code,status:e.status||r.status,retryable:e.retryable})}return p.result}
function setError(error){const el=$("error");if(!error){el.hidden=true;return}el.hidden=false;$("errorMessage").textContent=error.message||String(error);$("errorHint").textContent=error.retryable?" Try again; check the extension log if it persists.":" Check the input and refresh."}
function relative(value){if(!value)return"Date unavailable";const d=new Date(value);if(Number.isNaN(d.getTime()))return String(value);const seconds=Math.round((d-Date.now())/1000),abs=Math.abs(seconds);if(abs<45)return"just now";const units=[[31536000,"year"],[2592000,"month"],[604800,"week"],[86400,"day"],[3600,"hour"],[60,"minute"]];for(const [size,name] of units)if(abs>=size){const n=Math.round(seconds/size);return new Intl.RelativeTimeFormat(undefined,{numeric:"auto"}).format(n,name)}return"just now"}
function mutation(action,label,t,iconName){return '<button data-action="'+action+'" data-id="'+esc(t.id)+'" title="Updates the Taskbean ledger" role="menuitem">'+icon(iconName)+esc(label)+'</button>'}
function actionSet(t){const secondary=[];if(t.status!=="in_progress"&&t.status!=="done")secondary.push(mutation("start_task","Mark in progress",t,"play"));if(t.status!=="done")secondary.push(mutation("complete_task","Mark complete",t,"check"));if(t.status!=="blocked"&&t.status!=="done")secondary.push(mutation("block_task","Mark blocked",t,"blocked"));const reviewNext=t.pullRequest?.href&&(t.status==="done"||t.needsYou?.kind==="Approval"||(Array.isArray(t.tags)&&t.tags.some(x=>/^(review-required|pr-review)$/i.test(String(x)))));if(reviewNext)return{label:"Open pull request",icon:"open",kind:"link",href:t.pullRequest.href,help:"Open the associated pull request.",secondary};if(t.status==="pending")return{label:"Start next",icon:"play",kind:"mutation",action:"start_task",help:"Marks this Taskbean item in progress.",secondary:secondary.filter(x=>!x.includes('data-action="start_task"'))};if(t.status==="in_progress")return{label:"Resume",icon:"play",kind:"details",help:"Open task details.",secondary};if(t.status==="blocked")return{label:"Review blocker",icon:"alert",kind:"details",help:"Open blocker details.",secondary};return{label:(t.origin?.detail||t.origin?.path||t.agent)?"Open result":"View details",icon:"open",kind:"details",help:"Open recorded task details.",secondary}}
function row(t,attention=false){const stamp=t.updated_at||t.completed_at||t.created_at||t.due_date;const origin=t.origin||{};const bits=[origin.label,relative(stamp)].filter(Boolean).join(" · ");const reason=attention&&t.needsYou?.detail?t.needsYou.detail:bits;const details=[[t.statusLabel,origin.label].filter(Boolean).join(" · "),origin.detail,!origin.detail&&origin.path?origin.path:"",t.notes?"Notes: "+t.notes:"",t.agent?"Agent: "+t.agent:"",t.due_date?"Due: "+t.due_date:"",t.pullRequest?"Pull request: "+t.pullRequest.repo+" #"+t.pullRequest.number+(t.pullRequest.state?" · "+t.pullRequest.state:""):"",...(Array.isArray(t.tags)?t.tags.map(x=>"Tag: "+x):[])].filter(Boolean).join(" · ")||"No additional evidence is recorded.";const a=actionSet(t),detailId="detail-"+String(t.id).replace(/[^A-Za-z0-9_-]/g,"-");const sessionId=origin.session?.id||"",sessionHref=origin.session?.href||"",sessionLabel=origin.session?.name?"Open session "+origin.session.name:"Open associated session";const prHref=t.pullRequest?.href||"",prLabel="Open pull request"+(t.pullRequest?.state?" ("+t.pullRequest.state+")":"");const sessionAction=sessionHref?'<button class="session-link" data-copy-link="'+esc(sessionHref)+'" aria-label="Copy session link" title="Copy session link (open it from the app or a browser)">'+icon("session")+'</button>':"";const menuSession=sessionHref?'<button data-copy-link="'+esc(sessionHref)+'" role="menuitem" aria-label="Copy session link">'+icon("session")+'Copy session link</button>':"";const menuPr=prHref?'<a href="'+esc(prHref)+'" target="_blank" rel="noopener noreferrer" role="menuitem" aria-label="'+esc(prLabel)+'">'+icon("open")+'Open pull request'+(t.pullRequest.state?' · '+esc(t.pullRequest.state):'')+'</a>':"";const detailTools=(sessionHref||prHref)?'<div class="detail-tools">'+(sessionHref?'<button class="detail-link" data-copy-link="'+esc(sessionHref)+'" aria-label="Copy session link">'+icon("session")+'Copy session link</button><button class="copy-session" data-copy-session="'+esc(sessionId)+'" aria-label="Copy session ID" title="Copy session ID">'+icon("copy")+'Copy ID</button><span class="copy-feedback" aria-live="polite"></span>':'')+(prHref?'<a class="detail-link" href="'+esc(prHref)+'" target="_blank" rel="noopener noreferrer" aria-label="'+esc(prLabel)+'">'+icon("open")+'Open pull request'+(t.pullRequest.state?' · '+esc(t.pullRequest.state):'')+'</a>':'')+'</div>':"";const primary=a.kind==="link"?'<a class="split-primary" href="'+esc(a.href)+'" target="_blank" rel="noopener noreferrer" aria-label="'+esc(a.label)+'" title="'+esc(a.help)+'">'+icon(a.icon)+'<span class="primary-text-wide">'+esc(a.label)+'</span></a>':'<button class="split-primary" data-primary="'+a.kind+'" '+(a.action?'data-action="'+a.action+'" ':'')+'data-id="'+esc(t.id)+'" aria-controls="'+detailId+'" aria-expanded="false" title="'+esc(a.help)+'">'+icon(a.icon)+'<span class="primary-text-wide">'+esc(a.label)+'</span><span class="sr-only"> for '+esc(t.displayTitle||t.title)+'</span></button>';const menu='<details class="action-menu"><summary aria-label="More actions for '+esc(t.displayTitle||t.title)+'" title="More actions">'+icon("chevron")+'</summary><div class="menu" role="menu"><div class="menu-label">Actions</div>'+menuSession+menuPr+a.secondary.join("")+'</div></details>';return '<article class="taskrow'+(attention?' attentionrow':'')+'">'+statusIcon(t).replace('class="icon"','class="icon status-icon '+esc(t.status)+'"')+'<div class="rowcopy"><div class="rowtitle">'+esc(t.displayTitle||t.title)+'</div><div class="'+(attention?'why':'meta')+'">'+esc(reason)+'</div></div><div class="rowactions">'+sessionAction+primary+menu+'</div><div class="task-detail" id="'+detailId+'" hidden><div>'+esc(details)+'</div>'+detailTools+'</div></article>'}
function renderProjects(){const prev=$("project").value,add=$("newProject").value;$("project").innerHTML='<option value="all">All workspaces · '+(state.workspaceTaskCount??0)+'</option>'+state.workspaces.map(w=>'<option value="'+esc(w.key)+'">'+esc(w.displayLabel||w.label)+' · '+w.count+'</option>').join("");$("newProject").innerHTML='<option value="">Current/default project</option>'+state.projects.map(p=>'<option value="'+esc(p.name)+'">'+esc(p.name)+'</option>').join("");$("project").value=[...$("project").options].some(o=>o.value===prev)?prev:"all";$("newProject").value=[...$("newProject").options].some(o=>o.value===add)?add:""}
function renderStats(){const s=state.summary||{},b=s.byStatus||{};const items=[["info","In view",s.total||0],["alert","Needs you",state.needsYou.length],["play","In progress",b.in_progress||0],["blocked","Blocked",b.blocked||0],["check","Done",b.done||0]];$("stats").innerHTML=items.map(x=>'<span class="chip">'+icon(x[0])+'<b>'+x[2]+'</b> '+x[1]+'</span>').join("")}
function renderContent(){const attention=state.needsYou||[],groups=state.outcomeGroups||[];let used=0;const rendered=[];for(const g of groups){if(used>=visibleLimit)break;const initiallyOpen=g.needsYou>0&&g.tasks.some(t=>t.status!=="done");const eligible=initiallyOpen?g.tasks.filter(t=>t.status!=="done"):g.tasks;const take=eligible.slice(0,visibleLimit-used);used+=take.length;const doneCount=g.tasks.filter(t=>t.status==="done").length;const groupLabel=g.sessionName?"Open session "+g.sessionName:"Open associated session";const groupSession=g.sessionHref?'<button class="session-link" data-copy-link="'+esc(g.sessionHref)+'" aria-label="Copy session link" title="Copy session link">'+icon("session")+'</button>':"";rendered.push('<details class="outcome" '+(initiallyOpen?'open':'')+'><summary><div><div class="outcome-title">'+esc(g.label)+'</div><div class="outcome-meta">'+esc(g.type)+' · '+esc(g.basis)+' · '+g.tasks.length+' '+(g.tasks.length===1?'item':'items')+(doneCount?' · '+doneCount+' completed':'')+(g.needsYou?' · '+g.needsYou+' needs you':'')+'</div></div><div class="rowactions">'+groupSession+icon("chevron")+'</div></summary><div class="outcome-body">'+take.map(t=>row(t)).join("")+'</div></details>')}const remaining=Math.max(0,(state.tasks||[]).length-used);$("content").innerHTML='<section class="section"><div class="sectionhead"><h2>'+icon("alert")+'Needs you</h2><p>Blocked or explicitly tagged evidence only · <span class="count">'+attention.length+'</span></p></div><div class="attention">'+(attention.length?attention.slice(0,2).map(t=>row(t,true)).join(""):'<div class="attention-empty">No recorded blockers, HITL gates, or approval tags in this view.</div>')+'</div></section><section class="section"><div class="sectionhead"><h2>'+icon("open")+'Outcome stack</h2><p>Explicit outcomes lead; reliable product and repository evidence forms provisional Workstreams.</p></div><div class="stack">'+(rendered.join("")||'<div class="empty">No tasks match this scope.</div>')+'</div>'+(remaining?'<button id="more" class="more">Show '+Math.min(12,remaining)+' more · '+remaining+' remaining</button>':'')+'</section>';if($("more"))$("more").onclick=()=>{visibleLimit+=12;renderContent()}}
function render(){renderProjects();renderStats();renderContent()}
async function refresh(){$("refresh").disabled=true;setError(null);try{state=await api("get_dashboard",filters());visibleLimit=8;render()}catch(e){setError(e)}finally{$("refresh").disabled=false}}
function syncFilters(){const d=$("filtersPanel");if(!filterTouched)d.open=matchMedia("(min-width:400px)").matches;$("filterToggleLabel").textContent=d.open?"Hide filters":"Filters"}syncFilters();$("filtersPanel").addEventListener("toggle",()=>{$("filterToggleLabel").textContent=$("filtersPanel").open?"Hide filters":"Filters"});$("filtersPanel").querySelector("summary").addEventListener("click",()=>{filterTouched=true});addEventListener("resize",syncFilters);
async function copySessionId(button){const value=button.dataset.copySession||button.dataset.copyLink;if(!/^(ghapp:[/][/]sessions[/])?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value||""))return;try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(value);else{const area=document.createElement("textarea");area.value=value;area.setAttribute("readonly","");area.style.position="fixed";area.style.opacity="0";document.body.append(area);area.select();if(!document.execCommand("copy"))throw new Error("Copy failed");area.remove()}const feedback=button.parentElement.querySelector(".copy-feedback");button.title="Copied";if(feedback){feedback.textContent="Copied";clearTimeout(button.__copyTimer);button.__copyTimer=setTimeout(()=>{feedback.textContent=""},1600)}}catch(error){setError(new DashboardActionError({message:"Could not copy the session ID.",retryable:true}))}}
$("refresh").onclick=refresh;["period","status","project"].forEach(id=>$(id).onchange=refresh);$("search").oninput=()=>{clearTimeout(window.__searchTimer);window.__searchTimer=setTimeout(refresh,250)};$("content").onclick=async e=>{const copy=e.target.closest("button[data-copy-session],button[data-copy-link]");if(copy){e.preventDefault();e.stopPropagation();await copySessionId(copy);return}const primary=e.target.closest("button[data-primary]");if(primary?.dataset.primary==="details"){const detail=$(primary.getAttribute("aria-controls"));detail.hidden=!detail.hidden;primary.setAttribute("aria-expanded",String(!detail.hidden));return}const b=e.target.closest("button[data-action]");if(!b)return;const message=(b.dataset.action==="start_task"?"Mark this Taskbean item in progress?":b.dataset.action==="complete_task"?"Mark this Taskbean item complete?":"Mark this Taskbean item blocked?")+" This updates the local ledger.";if(!confirm(message))return;b.disabled=true;setError(null);try{await api(b.dataset.action,{id:b.dataset.id});await refresh()}catch(x){setError(x)}finally{b.disabled=false}};document.addEventListener("click",e=>{document.querySelectorAll(".action-menu[open]").forEach(d=>{if(!d.contains(e.target))d.open=false})});document.addEventListener("keydown",e=>{const d=e.target.closest?.(".action-menu");if(!d)return;if(e.key==="Escape"){d.open=false;d.querySelector("summary").focus();e.preventDefault()}if(["ArrowDown","ArrowUp"].includes(e.key)){const items=[...d.querySelectorAll(".menu [role=menuitem]")];if(!items.length)return;const i=items.indexOf(document.activeElement),next=e.key==="ArrowDown"?(i+1)%items.length:(i-1+items.length)%items.length;items[next].focus();e.preventDefault()}});$("addForm").onsubmit=async e=>{e.preventDefault();setError(null);try{await api("add_task",{title:$("newTitle").value,project:$("newProject").value||undefined});$("newTitle").value="";await refresh()}catch(x){setError(x)}};$("report").onclick=async()=>{const b=$("report");b.disabled=true;setError(null);try{$("reportOut").textContent=JSON.stringify(await api("generate_report",{period:$("period").value==="all"?"week":$("period").value}),null,2)}catch(x){setError(x)}finally{b.disabled=false}};refresh();
</script></body></html>`;
}

async function startServer(instanceId) {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url || "/", "http://127.0.0.1");
            if (req.method === "GET" && url.pathname === "/") {
                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store",
                });
                res.end(renderHtml());
                return;
            }

            if (req.method === "POST" && url.pathname === "/api/action") {
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
    return { server, url: `http://127.0.0.1:${port}/` };
}

function action(name, description, inputSchema, handler) {
    return { name, description, inputSchema, handler };
}

function safeAction(name, description, inputSchema, handler) {
    return action(name, description, inputSchema, (ctx) => withSafeErrors(`canvas action ${name}`, () => handler(ctx)));
}

function getAvailability(ctx) {
    return describeAvailability({ extensionId: ctx.extensionId, canvasId: ctx.canvasId, extensionFile: EXTENSION_FILE });
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
            additionalContext: "The Taskbean Dashboard canvas is available. Use it when the user asks to view, manage, or report on Taskbean tasks across workspaces. Chronicle reconciliation uses the Taskbean skill and CLI, not a dashboard action.",
        }),
    },
});

await session.log("Taskbean Dashboard canvas extension loaded.", { level: "info", ephemeral: true });
