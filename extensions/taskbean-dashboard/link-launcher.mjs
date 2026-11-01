import { execFile, spawn as nodeSpawn } from "node:child_process";
import { join } from "node:path";

const SESSION_URL_RE = /^ghapp:\/\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PR_PATH = "github\\.com\\/[A-Za-z0-9_.-]{1,100}\\/[A-Za-z0-9_.-]{1,100}\\/pull\\/[1-9]\\d{0,9}";
const APP_PR_URL_RE = new RegExp(`^ghapp:\\/\\/${PR_PATH}$`);
const WEB_PR_URL_RE = new RegExp(`^https:\\/\\/${PR_PATH}$`);
const DOT_SEGMENT_RE = /\/\.{1,2}(\/|$)/;

export class LinkError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "LinkError";
        this.code = code;
    }
}

export function isLaunchableUrl(url) {
    const text = String(url || "");
    if (DOT_SEGMENT_RE.test(text.replace(/^[a-z]+:\/\//, "/"))) return false;
    return SESSION_URL_RE.test(text) || APP_PR_URL_RE.test(text) || WEB_PR_URL_RE.test(text);
}

export function buildLaunch(url, { platform = process.platform, env = process.env } = {}) {
    if (!isLaunchableUrl(url)) throw new LinkError("taskbean_link_unavailable", "This link is not a trusted Copilot session or pull request.");
    if (platform === "win32") {
        const root = env.SystemRoot || env.windir || "C:\\Windows";
        return { command: join(root, "explorer.exe"), args: [url] };
    }
    if (platform === "darwin") return { command: "/usr/bin/open", args: [url] };
    return { command: "xdg-open", args: [url] };
}

// Only Windows has a verified handler probe. Other platforms report links as unavailable
// instead of assuming a handler exists.
function defaultHandlerCheck(scheme, { platform = process.platform, env = process.env } = {}) {
    if (platform !== "win32") return Promise.resolve(false);
    const reg = join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "reg.exe");
    return new Promise((resolve) => {
        execFile(reg, ["query", `HKCR\\${scheme}\\shell\\open\\command`, "/ve"], { windowsHide: true, timeout: 5000 }, (error) => resolve(!error));
    });
}

export async function launchUrl(url, options = {}) {
    const { spawn = nodeSpawn, platform = process.platform, env = process.env } = options;
    const hasHandler = options.hasHandler || ((scheme) => defaultHandlerCheck(scheme, { platform, env }));
    const { command, args } = buildLaunch(url, { platform, env });
    const scheme = url.slice(0, url.indexOf(":"));
    if (scheme !== "https" && !(await hasHandler(scheme))) {
        throw new LinkError("taskbean_link_unavailable", platform === "win32"
            ? "The GitHub Copilot app is not registered for ghapp:// links on this machine."
            : "Opening Copilot sessions from the canvas is only verified on Windows.");
    }
    await new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
        } catch (error) {
            reject(new LinkError("taskbean_link_failed", `Could not start the link handler (${error.code || "error"}).`));
            return;
        }
        child.once("error", (error) => reject(new LinkError("taskbean_link_failed", `Could not start the link handler (${error.code || "error"}).`)));
        child.once("spawn", () => {
            child.unref?.();
            resolve();
        });
    });
    return { opened: true, url };
}

export async function navigationSupport(options = {}) {
    const { platform = process.platform, env = process.env } = options;
    const hasHandler = options.hasHandler || ((scheme) => defaultHandlerCheck(scheme, { platform, env }));
    let sessions = false;
    try { sessions = Boolean(await hasHandler("ghapp")); } catch { sessions = false; }
    return {
        sessions: {
            available: sessions,
            reason: sessions ? null : platform === "win32"
                ? "The GitHub Copilot app is not registered for ghapp:// links on this machine."
                : "Opening Copilot sessions from the canvas is only verified on Windows.",
        },
        pullRequests: { available: true, reason: null, fallback: sessions ? null : "https" },
    };
}
