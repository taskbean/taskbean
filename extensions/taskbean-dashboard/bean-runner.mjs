import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";

const SHIM_NAMES = ["bean", "taskbean"];
const MAX_BUFFER = 20 * 1024 * 1024;

export class BeanCommandError extends Error {
    constructor(kind, message, details = {}) {
        super(message);
        this.name = "BeanCommandError";
        this.kind = kind;
        Object.assign(this, details);
    }
}

function pathDirs(env) {
    const raw = env.PATH ?? env.Path ?? env.path ?? "";
    return raw.split(delimiter).map((dir) => dir.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
}

function isTaskbeanEntry(file) {
    try {
        const pkg = JSON.parse(readFileSync(join(dirname(dirname(file)), "package.json"), "utf8"));
        return pkg.name === "taskbean" && existsSync(file);
    } catch {
        return false;
    }
}

export function resolveCliEntry({ env = process.env } = {}) {
    if (env.TASKBEAN_CLI_ENTRY) return existsSync(env.TASKBEAN_CLI_ENTRY) ? env.TASKBEAN_CLI_ENTRY : null;
    for (const dir of pathDirs(env)) {
        const candidates = [
            join(dir, "node_modules", "taskbean", "bin", "taskbean.js"),
            join(dirname(dir), "lib", "node_modules", "taskbean", "bin", "taskbean.js"),
        ];
        for (const name of SHIM_NAMES) {
            const shim = join(dir, name);
            if (!existsSync(shim)) continue;
            try {
                const real = realpathSync(shim);
                if (real.endsWith(".js")) candidates.push(real);
            } catch {}
        }
        const hasShim = SHIM_NAMES.some((name) => ["", ".cmd", ".ps1"].some((ext) => existsSync(join(dir, name + ext))));
        if (!hasShim) continue;
        const entry = candidates.find(isTaskbeanEntry);
        if (entry) return entry;
    }
    return null;
}

export function resolveNodeRuntime({ execPath = process.execPath, env = process.env, platform = process.platform } = {}) {
    if (/^node(\.exe)?$/i.test(basename(execPath))) return execPath;
    const names = platform === "win32" ? ["node.exe"] : ["node"];
    for (const dir of pathDirs(env)) {
        for (const name of names) {
            const file = join(dir, name);
            if (existsSync(file)) return file;
        }
    }
    return null;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

export function cmdEscapeArg(value, doubleEscape = true) {
    let arg = String(value);
    arg = arg.replace(/(\\*)"/g, '$1$1\\"');
    arg = arg.replace(/(\\*)$/, "$1$1");
    arg = `"${arg}"`;
    arg = arg.replace(CMD_META, "^$1");
    if (doubleEscape) arg = arg.replace(CMD_META, "^$1");
    return arg;
}

export function buildInvocation(args, { env = process.env, platform = process.platform, execPath = process.execPath, shim = "bean" } = {}) {
    const entry = resolveCliEntry({ env });
    const runtime = entry ? resolveNodeRuntime({ execPath, env, platform }) : null;
    if (entry && runtime) {
        return { mode: "direct", file: runtime, args: [entry, ...args], options: {} };
    }
    if (platform !== "win32") return { mode: "shim", file: shim, args, options: {} };
    const line = [shim, ...args.map((arg) => cmdEscapeArg(arg))].join(" ");
    return {
        mode: "cmd",
        file: env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", `"${line}"`],
        options: { windowsVerbatimArguments: true },
    };
}

function parseJsonError(stdout) {
    try {
        const payload = JSON.parse(String(stdout).trim());
        return payload && typeof payload === "object" && typeof payload.error === "string" ? payload : null;
    } catch {
        return null;
    }
}

export function classifyFailure({ error, stdout = "", stderr = "", args, mode }) {
    const exitCode = typeof error?.code === "number" ? error.code : null;
    const details = { exitCode, stdout: String(stdout), stderr: String(stderr), args, mode };
    const payload = parseJsonError(stdout);
    const text = `${payload?.message || ""}\n${stderr}`;
    if (error?.code === "ENOENT" || (mode !== "direct" && /is not recognized|command not found|No such file/i.test(stderr))) {
        return new BeanCommandError("cli_unavailable", "Could not find the taskbean CLI (`bean`) on PATH.", details);
    }
    if (error?.killed || error?.signal) {
        return new BeanCommandError("interrupted", `Taskbean CLI was interrupted (${error.signal || "killed"}).`, details);
    }
    if (/database is locked|SQLITE_BUSY|errcode:\s*5/i.test(text)) {
        return new BeanCommandError("busy", "Taskbean database is locked.", details);
    }
    if (payload?.error === "not_found" || /Task not found/i.test(text)) {
        return new BeanCommandError("task_not_found", payload?.message || "Task not found.", { ...details, payload });
    }
    if (payload) {
        return new BeanCommandError("cli_rejected", payload.message || payload.error, { ...details, payload });
    }
    const firstLine = String(stderr).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (/^error: (too many arguments|missing required argument|unknown option|option .* argument missing)/i.test(firstLine || "")) {
        return new BeanCommandError("cli_usage", firstLine, details);
    }
    return new BeanCommandError("cli_failed", firstLine || `Taskbean CLI exited with code ${exitCode ?? "unknown"}.`, details);
}

export function runBean(args, { env = process.env, platform = process.platform, execPath = process.execPath } = {}) {
    const invocation = buildInvocation(args, { env, platform, execPath });
    return new Promise((resolve, reject) => {
        execFile(invocation.file, invocation.args, {
            ...invocation.options,
            env,
            windowsHide: true,
            maxBuffer: MAX_BUFFER,
            encoding: "utf8",
        }, (error, stdout, stderr) => {
            if (error) {
                reject(classifyFailure({ error, stdout, stderr, args, mode: invocation.mode }));
                return;
            }
            resolve(String(stdout || "").trim());
        });
    });
}
