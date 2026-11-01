import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getAvailability } from "./availability.mjs";

const extensionFile = fileURLToPath(new URL("./extension.mjs", import.meta.url));

for (const scope of ["plugin", "user", "project", "session"]) {
    test(`availability reports ${scope} rather than a hardcoded user scope`, () => {
        const result = getAvailability({ extensionId: `${scope}:taskbean-dashboard`, extensionFile });
        assert.equal(result.scope, scope);
        assert.equal(result.available, true);
        assert.equal(result.globallyAvailableLocally, scope === "plugin" || scope === "user");
        assert.equal(result.entrypoint, extensionFile);
        assert.equal(result.canonicalScope, undefined);
        assert.equal(result.recommendedGitIgnoreGuardrails, undefined);
    });
}

test("missing provider identity is not reported as runtime availability", () => {
    const result = getAvailability({ extensionFile });
    assert.equal(result.available, false);
    assert.equal(result.scope, "unknown");
    assert.equal(result.globallyAvailableLocally, false);
});
