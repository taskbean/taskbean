# Product

## Register

product

## Users

The primary user is a developer who works across multiple repositories with coding agents and needs a fast, trustworthy way to see what work is pending, in progress, blocked, or completed. The secondary users are the agents themselves: they need a clear, structured surface for reading task state, adding new tasks, and updating status through taskbean's canonical CLI.

The usage context is the GitHub Copilot app, usually during active development or end-of-day/week review. The surface should work as a cockpit: glanceable enough for quick status checks, precise enough for reconciliation and reporting, and calm enough to stay open beside agent work.

## Product Purpose

Taskbean Dashboard is a Copilot plugin canvas for viewing and managing local taskbean tasks across projects. It exists to make taskbean feel native inside the Copilot app without replacing taskbean's local-first storage model or the `bean` CLI.

Success means the user can open one canvas and immediately answer: what is active, what is blocked, what completed this week, which projects are represented, and what report data can be trusted. Agent actions should use taskbean commands for writes so the canvas, CLI, and standalone app remain consistent.

## Brand Personality

Local-first, precise, and lightly cheeky.

The product voice should inherit taskbean's public promise: "Your tasks. Your machine. No compromise." It should feel private, direct, and useful rather than corporate or cloud-heavy. The recurring reminders show the allowed personality range: practical care with a wink, like "Go outside. Feel the sun. Remember you have legs." or "Hydrate or diedrate. Your call." That tone can appear in empty states, nudges, and low-risk helper copy, but core task controls and error messages should remain crisp and unambiguous.

## Anti-references

- Generic SaaS dashboards with abstract metrics, decorative gradients, and cloud-first productivity language.
- Bland GitHub-default boards that feel technically functional but not specifically taskbean.
- Overly cute productivity apps where the joke competes with the work.
- Agent-history summarizers that infer completed work without letting the user review evidence.
- Dense admin tables that hide the status lanes and human workflow behind raw data.

## Design Principles

1. **Local truth first.** The interface should reinforce that taskbean's local task ledger is canonical; Chronicle/session evidence may enrich or suggest, but it should not silently rewrite task history.
2. **Make work status unmistakable.** Pending, in-progress, blocked, and done states must be visually distinct without relying on color alone.
3. **Stay in the developer's flow.** The canvas should support quick reads and single-action updates; avoid modal-heavy or ceremony-heavy interactions.
4. **Trust beats decoration.** Use restrained product UI patterns, strong contrast, and consistent controls. Personality belongs in supportive copy, not in reinvented affordances.
5. **One surface, your rules.** Cross-project task management should feel personal, private, and configurable while preserving the same data used by `bean` and the taskbean app.

## Accessibility & Inclusion

Target WCAG AA contrast for text and controls. Use status labels, icons, shape, and layout in addition to color for task state. Respect `prefers-reduced-motion` and avoid decorative motion. Ensure keyboard-operable controls, visible focus states, readable small text, and compact layouts that still work in the Copilot app side panel.
