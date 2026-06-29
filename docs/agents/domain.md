# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`** for architecture decisions that touch the area being changed.

If any of these files don't exist, proceed silently. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions actually get resolved.

## File structure

Taskbean uses a single-context layout. The CLI and desktop app are separate product surfaces, but they share one Taskbean domain centered on tasks, projects, agent attribution, Chronicle evidence, reminders, reports, and the shared local database.

Expected structure:

```
/
├── CONTEXT.md
├── docs/adr/
└── app/
└── cli/
```

## Use the glossary's vocabulary

When output names a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept isn't in the glossary yet, either reconsider whether the term belongs in the project language or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly rather than silently overriding.

