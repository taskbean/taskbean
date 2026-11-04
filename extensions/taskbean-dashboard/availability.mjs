import { dirname } from "node:path";

export function getAvailability({ extensionId = "", canvasId = "taskbean-dashboard", extensionFile }) {
    const scope = extensionId.includes(":") ? extensionId.split(":")[0] : "unknown";
    return {
        available: Boolean(extensionId),
        scope,
        extensionId,
        canvasId,
        installationPath: dirname(extensionFile),
        entrypoint: extensionFile,
        globallyAvailableLocally: scope === "user" || scope === "plugin",
        projectShadowing: "Other user or project copies can expose duplicate providers. Check the extension ID before invoking actions.",
        cloudSessionBoundary: "The dashboard requires a local Copilot canvas host and an installed Taskbean CLI. Installation does not make it available in cloud sessions.",
        activationBoundary: "Plugin availability depends on installation, activation and host policy in the current session.",
    };
}
