import assert from "node:assert/strict";
import { rowActions } from "./row-actions.mjs";

const SESSION = { id: "4e0f6a52-1c3b-4d5e-8f90-a1b2c3d4e5f6", name: "Wire deeplinks" };
const PR = { href: "https://github.com/octocat/hello-world/pull/42", appLink: "ghapp://github.com/octocat/hello-world/pull/42", repo: "octocat/hello-world", number: 42 };
const task = (status, extra = {}) => ({ id: "t1", title: "Task", status, origin: {}, ...extra });
const key = (x) => [x.kind, x.action || x.target || x.value].join(":");

const cases = [
    [task("pending"), "mutation:start_task"],
    [task("in_progress", { origin: { session: SESSION } }), "open:session"],
    [task("blocked", { origin: { session: SESSION } }), "open:session"],
    [task("done", { pullRequest: PR }), "open:pull_request"],
    [task("in_progress", { pullRequest: PR, tags: ["review-required"] }), "open:pull_request"],
    [task("in_progress"), null],
    [task("blocked"), null],
    [task("done"), null],
    [task("done", { origin: { session: SESSION } }), null],
];

for (const [t, expected] of cases) {
    const { primary, secondary } = rowActions(t);
    assert.equal(primary ? key(primary) : null, expected, `${t.status} primary`);
    for (const item of [primary, ...secondary].filter(Boolean)) {
        assert.notEqual(item.kind, "details", "details is never an action kind");
        assert.ok(["open", "mutation", "copy"].includes(item.kind), item.kind);
        assert.ok(item.label && item.help, "every action has a label and help text");
    }
    if (primary) {
        assert.ok(!secondary.some((x) => key(x) === key(primary)), `${t.status}: primary is not repeated in the menu`);
        if (primary.kind === "open") assert.ok(!secondary.some((x) => x.kind === "mutation" && x.label === primary.label), "link primaries are not status changes");
    }
    assert.equal(new Set(secondary.map(key)).size, secondary.length, "menu items are unique");
}

assert.deepEqual(rowActions(task("done")), { primary: null, secondary: [] }, "a done task without evidence has no actions");

const pending = rowActions(task("pending"));
assert.equal(pending.primary.label, "Start");
assert.equal(pending.primary.style, "start", "Start is the only filled primary");
assert.ok(!pending.secondary.some((x) => x.action === "start_task"), "Start is not repeated as Mark in progress");
assert.deepEqual(pending.secondary.map(key), ["mutation:block_task", "mutation:complete_task", "copy:t1"]);

const resume = rowActions(task("in_progress", { origin: { session: SESSION } }));
assert.equal(resume.primary.label, "Resume");
assert.equal(resume.primary.ariaLabel, "Resume in Copilot session Wire deeplinks");
assert.equal(resume.primary.style, "nav");
assert.equal(resume.primary.icon, "open");
assert.equal(resume.primary.help, "Opens the Copilot session. Task status does not change.");
assert.deepEqual(resume.secondary.map(key), ["mutation:block_task", "mutation:complete_task", "copy:t1"], "status items follow lifecycle order");
assert.deepEqual(resume.secondary.map((x) => x.group), ["status", "status", "links"], "status items come before links");

const blocked = rowActions(task("blocked", { origin: { session: SESSION }, pullRequest: PR }));
assert.equal(blocked.primary.label, "Review blocker");
assert.ok(blocked.secondary.some((x) => x.target === "pull_request"), "the PR stays reachable from the menu");
assert.ok(!blocked.secondary.some((x) => x.action === "block_task"));

const doneSession = rowActions(task("done", { origin: { session: SESSION } }));
assert.deepEqual(doneSession.secondary.map(key), ["open:session", "copy:t1"]);
assert.equal(doneSession.secondary[0].sessionId, SESSION.id);

const donePr = rowActions(task("done", { pullRequest: PR }));
assert.equal(donePr.primary.label, "Open PR", "done rows with a PR show Open PR as the primary");
assert.equal(donePr.primary.style, "nav");
assert.deepEqual(donePr.secondary, [], "Open PR is not repeated in the menu");

// The function is inlined into the client with toString(), so it must be self-contained.
const inlined = new Function(`${rowActions.toString()}; return rowActions;`)();
assert.deepEqual(inlined(task("blocked", { origin: { session: SESSION } })), rowActions(task("blocked", { origin: { session: SESSION } })));

console.log("row-actions tests passed");
