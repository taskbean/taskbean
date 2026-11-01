const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validatedUuid(value) {
    const text = String(value || "").trim();
    return UUID_RE.test(text) ? text.toLowerCase() : "";
}

export function resolveTrustedCopilotSession(task = {}) {
    const direct = validatedUuid(task.session_id);
    const agentValue = String(task.agent_session_id || "").trim();
    const prefixed = agentValue.match(/^copilot:([0-9a-f-]+)$/i);
    const agentId = prefixed ? validatedUuid(prefixed[1]) : (/copilot/i.test(String(task.agent || "")) ? validatedUuid(agentValue) : "");
    const id = direct || agentId;
    if (!id) return null;
    const suppliedName = String(task.session_name || task.chat_name || task.conversation_name || "").trim();
    return { id, name: suppliedName };
}

export function sessionDeepLink(sessionId) {
    const id = validatedUuid(sessionId);
    return id ? `ghapp://sessions/${id}` : "";
}

export function escapeHtmlAttribute(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&#39;");
}


const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_URL_RE = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?=$|[\s/?#),.;:!\]])/i;

function positiveInteger(value) {
    const text = String(value ?? "").trim();
    return /^[1-9]\d*$/.test(text) ? text : "";
}

function canonicalPr(repo, number, state = "") {
    const cleanRepo = String(repo || "").trim();
    const cleanNumber = positiveInteger(number);
    if (!REPO_RE.test(cleanRepo) || !cleanNumber) return null;
    const [owner, name] = cleanRepo.split("/");
    if ([owner, name].some((part) => part === "." || part === ".." || part.length > 100)) return null;
    return {
        repo: `${owner}/${name}`,
        number: cleanNumber,
        state: String(state || "").trim().toLowerCase(),
        href: `https://github.com/${owner}/${name}/pull/${cleanNumber}`,
        appLink: `ghapp://github.com/${owner}/${name}/pull/${cleanNumber}`,
    };
}

function parsePrUrl(value, state = "") {
    const match = String(value || "").match(PR_URL_RE);
    return match ? canonicalPr(`${match[1]}/${match[2]}`, match[3], state) : null;
}

export function resolveTrustedPullRequest(task = {}) {
    const state = task.pull_request_state || task.pr_state || task.created_pr_state || "";
    const explicitUrl = task.pr_url || task.pull_request_url || task.created_pr_url;
    const fromUrl = parsePrUrl(explicitUrl, state);
    if (fromUrl) return fromUrl;

    const repo = task.created_pr_repo || task.pull_request_repo || task.pr_repo || task.repository || task.repo;
    const number = task.created_pr_number || task.pull_request_number || task.pr_number;
    const fromFields = canonicalPr(repo, number, state);
    if (fromFields) return fromFields;

    const recordText = [task.notes, ...(Array.isArray(task.tags) ? task.tags : [])].filter(Boolean).join(" ");
    return parsePrUrl(recordText, state);
}
