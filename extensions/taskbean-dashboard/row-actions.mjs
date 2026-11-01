// Self-contained: this function is inlined into the canvas client with toString().
// It must not reference anything outside its own body.
// nav: optional { sessions: { available, reason } } from the server. When session navigation
// is unavailable, session actions degrade to an explicit "Copy session ID" with the reason.
export function rowActions(t, nav) {
    const session = t && t.origin && t.origin.session && t.origin.session.id ? t.origin.session : null;
    const pr = t && t.pullRequest && t.pullRequest.href ? t.pullRequest : null;
    const tags = Array.isArray(t && t.tags) ? t.tags : [];
    const reviewReady = Boolean(pr) && (t.status === "done" || (t.needsYou && t.needsYou.kind === "Approval") || tags.some((x) => /^(review-required|pr-review)$/i.test(String(x))));
    const sessionName = session && session.name ? session.name : "";
    const sessionsOk = !(nav && nav.sessions && nav.sessions.available === false);
    const sessionReason = nav && nav.sessions && nav.sessions.reason ? String(nav.sessions.reason) : "Opening Copilot sessions is unavailable here.";
    const openSession = (label) => sessionsOk ? ({
        kind: "open", target: "session", style: "nav", group: "links", label, icon: "open", sessionId: session.id,
        ariaLabel: (label === "Open session" ? "Open" : label) + " in Copilot session" + (sessionName ? " " + sessionName : ""),
        help: "Opens the Copilot session. Task status does not change.",
    }) : ({
        kind: "copy", copy: "session", style: "nav", group: "links", label: "Copy session ID", icon: "copy", value: session.id, unavailable: true,
        ariaLabel: "Copy session ID" + (sessionName ? " for " + sessionName : "") + ". " + label + " is unavailable: " + sessionReason,
        help: label + " is unavailable: " + sessionReason + " Copies the session ID instead.",
    });
    const openPr = () => ({
        kind: "open", target: "pull_request", style: "nav", group: "links", label: "Open PR", icon: "open",
        ariaLabel: "Open pull request " + pr.repo + " #" + pr.number + (pr.state ? " (" + pr.state + ")" : ""),
        help: "Opens the pull request. Task status does not change.",
    });
    const mutation = (action, label, icon, style) => ({ kind: "mutation", action, label, icon, style, group: "status", help: "Changes the task status in the Taskbean ledger." });

    let primary = null;
    if (t.status === "in_progress" && session) primary = openSession("Resume");
    else if (t.status === "blocked" && session) primary = openSession("Review blocker");
    else if (reviewReady) primary = openPr();
    else if (t.status === "pending") primary = mutation("start_task", "Start", "play", "start");

    // Lifecycle order: in progress, blocked, done. Reopen needs a CLI reopen command first.
    const secondary = [];
    if (t.status !== "in_progress" && t.status !== "done" && !(primary && primary.action === "start_task")) secondary.push(mutation("start_task", "Mark in progress", "play"));
    if (t.status !== "blocked" && t.status !== "done") secondary.push(mutation("block_task", "Mark blocked", "blocked"));
    if (t.status !== "done") secondary.push(mutation("complete_task", "Mark done", "check"));
    if (session && !(primary && (primary.target === "session" || primary.copy === "session"))) secondary.push(openSession("Open session"));
    if (pr && !(primary && primary.target === "pull_request")) secondary.push(openPr());
    if (secondary.length && t.id) secondary.push({ kind: "copy", group: "links", value: String(t.id), label: "Copy task ID", icon: "copy", help: "Copies the Taskbean task ID." });
    return { primary, secondary };
}
