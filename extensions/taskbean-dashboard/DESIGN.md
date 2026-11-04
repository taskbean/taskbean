---
name: Taskbean Dashboard
description: A local-first Copilot canvas cockpit for cross-project taskbean tasks.
colors:
  roast-bg: "#1A120E"
  roast-surface: "#241A14"
  roast-surface-2: "#2E221A"
  roast-border: "#4A3828"
  roast-text: "#E8DDD0"
  roast-muted: "#A08E7C"
  ember-accent: "#E8863C"
  latte-bg: "#FAF6F1"
  latte-surface: "#FFFBF5"
  latte-surface-2: "#F0E8DE"
  latte-border: "#D4C4B0"
  latte-text: "#2C1810"
  latte-muted: "#7A6348"
  latte-accent: "#C8520A"
  success: "#6AAF5A"
  warning: "#D4922E"
  danger: "#E85A4A"
  purple: "#BC8CCC"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.2
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, sans-serif"
    fontSize: "16px"
    fontWeight: 650
    lineHeight: 1.25
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: "16px"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "18px"
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ember-accent}"
    textColor: "{colors.roast-bg}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  button-secondary:
    backgroundColor: "{colors.roast-surface-2}"
    textColor: "{colors.roast-text}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.roast-surface}"
    textColor: "{colors.roast-text}"
    rounded: "{rounded.lg}"
    padding: "12px"
  chip:
    backgroundColor: "{colors.roast-surface-2}"
    textColor: "{colors.roast-muted}"
    rounded: "{rounded.pill}"
    padding: "2px 7px"
---

# Design System: Taskbean Dashboard

## 1. Overview

**Creative North Star: "The Local Workbench"**

Taskbean Dashboard should feel like a trusted workbench embedded inside Copilot: close at hand, private by default, and built for the developer who wants an honest accounting of agent work without another cloud dashboard. The interface is product-first and restrained, but it should retain taskbean's coffee-toned warmth and occasional dry humor. It is not generic GitHub chrome; it is the taskbean cockpit.

The system rejects abstract SaaS productivity polish. No gradient hero metrics, no decorative glass panels, no cloud-first AI language, and no completed-work claims that lack a taskbean record. Personality comes through in empty states, reminders, and helper copy; high-stakes controls and errors stay plain.

**Key Characteristics:**

- Local-first and privacy-forward.
- Dense enough for cross-project work, but organized around human-readable status lanes.
- Warm coffee palette with ember accents, not neutral SaaS blue as the primary brand.
- Familiar product controls with consistent focus, hover, disabled, and error states.
- Light cheekiness only where it reduces friction or makes an empty state less dead.

## 2. Colors

The palette is a coffee system: dark roast for default focus mode, latte for light mode, ember for action, and semantic accents for state.

### Primary

- **Ember Accent** (#E8863C): the taskbean action color. Use for primary actions, active navigation, focus cues, selected filters, and the smallest amount of brand heat on a screen.
- **Latte Accent** (#C8520A): the light-mode equivalent when the surface is cream-toned and needs stronger contrast.

### Secondary

- **Success Green** (#6AAF5A): completed tasks, saved state, and positive readiness.
- **Warning Orange** (#D4922E): overdue, paused, reconnecting, or attention-needed states that are not failures.
- **Danger Red** (#E85A4A): errors, destructive actions, and blocked/failed feedback.
- **Agent Purple** (#BC8CCC): optional secondary semantic color for agent/session context, not general decoration.

### Neutral

- **Dark Roast Background** (#1A120E): the default deep work background for the standalone taskbean personality.
- **Dark Roast Surface** (#241A14): primary panels and header surfaces.
- **Dark Roast Raised Surface** (#2E221A): nested controls, cards, input fields, and secondary panels.
- **Roast Border** (#4A3828): dividers and low-emphasis outlines.
- **Roast Text** (#E8DDD0): primary readable text on dark coffee surfaces.
- **Roast Muted** (#A08E7C): metadata, helper copy, and inactive labels.
- **Latte Background** (#FAF6F1): light-mode page background.
- **Latte Surface** (#FFFBF5): light-mode panels.
- **Latte Raised Surface** (#F0E8DE): light-mode nested controls and cards.
- **Latte Border** (#D4C4B0): light-mode dividers.
- **Latte Text** (#2C1810): light-mode primary text.
- **Latte Muted** (#7A6348): light-mode metadata and secondary labels.

### Named Rules

**The Ember Is Rare Rule.** Ember is an affordance, not decoration. If it appears everywhere, it stops meaning "act here."

**Status Is Not Color Alone.** Task status must also be expressed with labels, lane titles, counts, icons, or layout. Color reinforces; it never carries the whole meaning.

## 3. Typography

**Display Font:** System sans (`-apple-system`, BlinkMacSystemFont, Segoe UI, Helvetica, sans-serif)<br>
**Body Font:** System sans (`-apple-system`, BlinkMacSystemFont, Segoe UI, Helvetica, sans-serif)<br>
**Label/Mono Font:** `ui-monospace`, `SFMono-Regular`, Menlo, Consolas, monospace for command/report/session evidence.

**Character:** Product typography should be boring in the best way: legible, familiar, and dense enough for a developer cockpit. Do not introduce display fonts or editorial type contrast into task controls.

### Hierarchy

- **Headline** (700, 24px, 1.2): top-level canvas title and rare major section headings.
- **Title** (650, 16px, 1.25): panel titles, lane labels, and task titles.
- **Body** (400, 14px, 20px): task metadata, explanations, panel text, and report summaries.
- **Label** (600, 12px, 16px): buttons, chips, filters, counts, helper labels.
- **Mono** (400, 12px, 18px): `bean` commands, JSON/report previews, session identifiers, and file paths.

### Named Rules

**The Tool Text Rule.** If text is part of a task control, prioritize speed and clarity over charm. Save voice for optional helper copy.

## 4. Elevation

Taskbean uses tonal layering first and shadows second. Depth comes from background changes, borders, radius, and sticky structure. Shadows may appear on floating modals, focused overlays, or draggable/hovered task cards, but resting panels should stay grounded.

### Shadow Vocabulary

- **Resting Surface** (`none`): lanes, cards, filters, and most panels.
- **Soft Card Lift** (`0 1px 2px rgba(0,0,0,.04)`): lightweight task cards when they need separation inside a lane.
- **Modal Lift** (`0 24px 48px rgba(0,0,0,.4)`): overlays and modal surfaces only.

### Named Rules

**The Workbench Rule.** Surfaces should feel placed on the bench, not floating above it. Use borders and tonal contrast before shadows.

## 5. Components

### Buttons

- **Shape:** compact rounded rectangles (`8px` radius).
- **Primary:** ember background, high-contrast text, semibold label, `8px 12px` or denser sizing in constrained side panels.
- **Secondary:** raised surface background, border, primary text, same radius and padding as primary.
- **Hover / Focus:** hover may swap to ember or raise contrast; focus must use a visible ring or border shift. Avoid animated flourish.
- **Disabled / Loading:** reduced opacity is acceptable only with cursor/state changes and preserved readable label text.

### Chips

- **Style:** pill radius, low-contrast raised surface, muted text, thin border.
- **State:** selected chips use accent-soft background plus accent border/text. Filters should remain compact and scannable.
- **Use:** tags, priorities, agent labels, model/tool metadata, and compact task attributes.

### Cards / Containers

- **Corner Style:** `12px` for panels/cards; `14px` for lane containers.
- **Background:** use surface for large panels and raised surface for nested cards/inputs.
- **Shadow Strategy:** resting cards are mostly flat; use soft lift only when cards sit on similarly colored lanes.
- **Border:** always prefer a real border over a decorative side stripe.
- **Internal Padding:** `10px` to `16px` depending on density. Side-panel canvases should favor compact rhythm.

### Inputs / Fields

- **Style:** solid background, 1px border, `8px` radius, system font.
- **Focus:** border or outline moves to ember/accent with enough contrast.
- **Placeholder:** readable, not pale gray. Placeholder copy can be lightly taskbean-flavored when low risk.
- **Error / Disabled:** errors use danger red plus explicit text. Disabled fields must remain legible.

### Navigation

- **Pattern:** compact filters and tabs over complex navigation. The canvas is a cockpit, not a website.
- **Project / status / period filters:** use native selects or standard button groups unless there is a clear reason to customize.
- **Active state:** accent-soft background and accent border/text; never rely on a hidden-only indicator.

### Task Lanes

- **Structure:** status lanes are the primary mental model. Each lane must show label, count, and empty state.
- **Density:** task cards should expose title, project, priority/status cues, and the few actions needed next.
- **Actions:** Start, Done, and Block should be predictable, compact, and available inline when safe.

## 6. Do's and Don'ts

**Do**

- Use taskbean's coffee palette as the identity anchor when the canvas is not purely inheriting host theme tokens.
- Keep agent/session evidence visually secondary to the task title and status.
- Put privacy/local-first cues in explanatory copy where helpful.
- Use short, concrete labels: "Start", "Done", "Block", "Generate report".
- Write empty states with taskbean personality: useful first, lightly cheeky second.

**Don't**

- Don't make the canvas look like a generic GitHub Projects clone.
- Don't use cloud-first AI phrases like "seamless productivity intelligence" or "unlock your workflow."
- Don't infer completion from session history without a review affordance.
- Don't introduce custom form controls unless native controls cannot satisfy the interaction.
- Don't use decorative side-stripe borders, gradient text, or glass panels as default styling.
