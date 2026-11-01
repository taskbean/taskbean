import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(extensionDir, "..", "..");
const manifestPath = join(root, "plugin.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
const requiredFiles = ["extension.mjs", "session-links.mjs", "availability.mjs", "bean-runner.mjs", "link-launcher.mjs", "row-actions.mjs"];
const missingFiles = requiredFiles.filter((file) => !existsSync(join(extensionDir, file)));
const declared = manifest?.extensions?.includes("extensions/taskbean-dashboard") === true;
const result = {
    ok: missingFiles.length === 0 && declared,
    check: "packaging",
    pluginName: manifest?.name ?? null,
    pluginVersion: manifest?.version ?? null,
    extensionName: "taskbean-dashboard",
    extensionDeclared: declared,
    missingFiles,
    runtimeVerified: false,
    cliVerified: false,
    nextStep: "Install the CLI and plugin, then invoke get_availability in a supported local canvas host.",
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
