---
name: taskbean
description: Local-first agent work ledger and task dashboard for developers.
colors:
  ember-accent: "#E8863C"
  ember-accent-deep: "#C8520A"
  dark-roast-bg: "#1A120E"
  dark-roast-surface: "#241A14"
  dark-roast-surface-raised: "#2E221A"
  dark-roast-border: "#4A3828"
  dark-roast-text: "#E8DDD0"
  dark-roast-muted: "#A08E7C"
  latte-bg: "#FAF6F1"
  latte-surface: "#FFFBF5"
  latte-surface-raised: "#F0E8DE"
  latte-border: "#D4C4B0"
  latte-text: "#2C1810"
  success-green: "#6AAF5A"
  warning-orange: "#D4922E"
  danger-red: "#E85A4A"
  agent-purple: "#BC8CCC"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-0.2px"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.35
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "'DM Mono', 'Cascadia Code', ui-monospace, monospace"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.5px"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  dialog: "16px"
  pill: "999px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  xxl: "14px"
  section: "16px"
  panel: "20px"
  page: "40px"
components:
  button-primary:
    backgroundColor: "{colors.ember-accent}"
    textColor: "{colors.dark-roast-bg}"
    rounded: "{rounded.sm}"
    padding: "6px 14px"
  button-primary-hover:
    backgroundColor: "{colors.ember-accent}"
    textColor: "{colors.dark-roast-bg}"
    rounded: "{rounded.sm}"
    padding: "6px 14px"
  button-secondary:
    backgroundColor: "{colors.dark-roast-surface-raised}"
    textColor: "{colors.dark-roast-text}"
    rounded: "{rounded.sm}"
    padding: "6px 14px"
  chip-selected:
    backgroundColor: "{colors.ember-accent}"
    textColor: "{colors.dark-roast-bg}"
    rounded: "{rounded.pill}"
    padding: "3px 9px"
  card:
    backgroundColor: "{colors.dark-roast-surface-raised}"
    textColor: "{colors.dark-roast-text}"
    rounded: "{rounded.lg}"
    padding: "14px"
  input:
    backgroundColor: "{colors.dark-roast-bg}"
    textColor: "{colors.dark-roast-text}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
---

# Design System: taskbean

## 1. Overview

**Creative North Star: "The Cheeky Agent Work Ledger"**

Taskbean is a warm technical product UI: a local ledger for agent work that feels precise enough for developers and personal enough to remember. The dominant surface is coffee-dark, compact, and tool-native; the ember accent marks current selection, primary action, and live state rather than decorating every panel.

The system rejects generic SaaS dashboard polish, obvious AI-template composition, overdecorated glassy panels, gratuitous gradients, and cute gamified todo-app patterns. It should read as a focused local instrument: dense enough for reports, usage telemetry, reminders, and Chronicle review, but friendly enough to make daily task review feel less like bookkeeping.

**Key Characteristics:**
- Coffee-themed surfaces with restrained ember emphasis.
- Dense product layouts built from rails, panes, rows, chips, and compact cards.
- Monospace metadata for ids, commands, counts, token usage, and evidence.
- State-rich feedback for local services, model loading, voice input, reminders, and reconciliation.
- Personality through copy and small affordances, not decorative chrome.

## 2. Colors

The palette is coffee-warm and operational: dark-roast surfaces carry the work, ember highlights action, and semantic colors describe system state.

### Primary
- **Ember Accent**: The canonical primary action and selection color. Use it for active nav items, focused controls, primary buttons, live status, linked evidence, and sparse emphasis.
- **Deep Ember**: The stronger light-theme accent for Latte surfaces and high-emphasis states that need more contrast.

### Secondary
- **Success Green**: Completion, healthy service state, installed agent skills, and positive confirmations.
- **Warning Orange**: Recoverable warnings, loading progress, stale server states, overdue-but-not-failed nudges, and attention that should not read as danger.
- **Danger Red**: Failed actions, destructive options, unavailable services, and overdue/critical states.
- **Agent Purple**: Agent/source identity, secondary categorization, and model/provider metadata when the primary accent is already carrying selection.

### Neutral
- **Dark Roast Background**: The main app background for focused work surfaces.
- **Dark Roast Surface**: Rails, headers, status bars, and major panels.
- **Dark Roast Raised Surface**: Cards, grouped controls, settings rows, chat bubbles, and nested information blocks.
- **Dark Roast Border**: Dividers and strokes that separate dense regions without adding shadow.
- **Dark Roast Text**: Primary text on dark themes.
- **Dark Roast Muted**: Secondary labels, hints, metadata, disabled states, and explanatory copy.
- **Latte Background and Surface**: Light-theme alternates that keep the coffee identity without changing component grammar.

### Named Rules
**The Ember Is Evidence Rule.** Ember is for current state, primary action, focus, or evidence; if it is only decoration, remove it.

**The Coffee Neutral Rule.** Neutral layers should stay inside the coffee family. Do not introduce generic blue-gray SaaS neutrals unless a platform integration explicitly requires them.

**The Semantic State Rule.** Green, orange, red, and purple must describe meaning. Never use them as arbitrary accent variety.

## 3. Typography

**Display Font:** system sans (`-apple-system`, BlinkMacSystemFont, `Segoe UI`, Helvetica, sans-serif)
**Body Font:** system sans (`-apple-system`, BlinkMacSystemFont, `Segoe UI`, Helvetica, sans-serif)
**Label/Mono Font:** `DM Mono` where available, with `Cascadia Code` / ui-monospace fallbacks

**Character:** The product uses one practical sans voice for speed and familiarity, then switches to monospace for machine-readable work evidence. Labels are compact and often uppercase; body copy stays direct and report-oriented.

### Hierarchy
- **Display** (700, 20px, 1.35): Task detail titles, major drawer titles, and the largest in-app headings.
- **Headline** (700, 17px, 1.35): Overlay titles, offline state headers, and compact empty-state headers.
- **Title** (600, 13px, 1.4): Section titles, modal headers, item titles, and component group labels.
- **Body** (400, 12px, 1.5): Row content, chat messages, detail copy, settings descriptions, and task summaries.
- **Label** (600, 9-11px, 0.4-1px tracking): Status chips, metadata labels, filters, tabs, counters, command snippets, and evidence tokens.

### Named Rules
**The Ledger Type Rule.** Use monospace only when the content behaves like a receipt: command, id, count, token usage, path, provider, model, timestamp, or source evidence.

**The Compact Product Rule.** Keep type sizes stable and compact. Do not introduce large fluid headings or marketing-display typography into product surfaces.

## 4. Elevation

Taskbean is tonal-first. Depth is conveyed by background layers, borders, focus rings, and small state shadows rather than broad card elevation. Shadows appear for temporary overlays, context menus, modals, hover affordances, and diagnostic panels that must float above dense UI.

### Shadow Vocabulary
- **Overlay Shadow** (`0 24px 48px rgba(0,0,0,.4)`): Model and settings modals.
- **Context Shadow** (`0 8px 30px rgba(0,0,0,.35)`): Context menus and compact popovers.
- **Soft Panel Shadow** (`0 8px 32px rgba(0,0,0,.18)`): Quick pickers, status popovers, and lightweight floating panels.
- **Action Glow** (`0 2px 8px color-mix(in oklch, var(--accent) 15%, transparent)`): Hover response on task-detail actions only when motion/hover communicates interactivity.

### Named Rules
**The Flat-Until-It-Floats Rule.** Permanent product surfaces are flat and bordered; temporary surfaces may cast a shadow because they are above the work plane.

**The Border Does the Work Rule.** If a card needs separation at rest, use `var(--border)` and tonal layering before reaching for shadow.

## 5. Components

### Buttons
- **Shape:** Compact rounded rectangles (6-8px), with pill shapes reserved for filters and metadata.
- **Primary:** Filled Ember Accent with dark-roast text for decisive actions; 6-14px vertical/horizontal padding for dense app contexts.
- **Hover / Focus:** Hover can shift background to accent and text to background. Focus uses a 2px accent outline or a 3px soft accent ring.
- **Secondary / Ghost / Tertiary:** Secondary buttons sit on raised coffee surfaces with border strokes. Ghost icon buttons are transparent until hover, then use `var(--surface2)`.

### Chips
- **Style:** Small rounded or pill controls with 1px borders, mono or compact sans labels, and semantic color only when selected or meaningful.
- **State:** Selected chips use accent-soft backgrounds and accent text; inactive chips stay muted. Agent/provider chips can use purple or muted variants when they describe source identity.

### Cards / Containers
- **Corner Style:** 8-10px for cards, 12px for popovers and modals, 16px for centered offline panels.
- **Background:** Use `var(--surface2)` for grouped content, `var(--bg)` for nested rows, and `var(--surface)` for rails and major panes.
- **Shadow Strategy:** No shadow at rest. Shadow belongs to overlays, popovers, context menus, and hover feedback where the element actually floats.
- **Border:** 1px `var(--border)` is the default separator. Dashed borders are reserved for empty/review states.
- **Internal Padding:** Dense rows use 6-10px; cards and grouped sections use 12-16px; modals use 16-20px.

### Inputs / Fields
- **Style:** Coffee-dark background, 1px border, 6-12px radius depending on scale, inherited sans body text, and monospace only for command/path/value fields.
- **Focus:** Accent border plus soft accent ring for composite inputs; simple controls may use a 2px focus outline.
- **Error / Disabled:** Error states use red-soft backgrounds or red borders with readable text. Disabled states reduce opacity but should keep labels legible.

### Navigation
- **Style:** A left-docked rail uses compact icon rows, muted defaults, accent-soft active state, and a narrow active indicator in collapsed mode. The expanded state reveals labels and badges without changing the row grammar.
- **Typography:** 12px semibold labels, 9-10px badges, compact spacing.
- **Mobile / narrow behavior:** Collapse or hide labels before removing functionality. Keep active state visible in icon-only mode.

### Chat and Composer
- **Style:** Chat bubbles are compact, asymmetric, and grounded in coffee surfaces. User bubbles use the warmer user-bubble token; AI bubbles sit on raised surface. Tool and error messages should move toward full tint + icon treatments instead of colored side stripes.
- **Composer:** Multi-line, bottom-docked, border-first, with icon buttons and model/device pills. Loading and recording states use subtle pulse only when reduced motion allows it.

### Status and Telemetry
- **Style:** The status bar is a compact receipt strip. Hardware, model, service, and clock chips use tabular/mono-adjacent treatment, container-query collapse, and semantic dots.
- **Nerd panel:** Uses tabs, raw event surfaces, sparklines/metrics, and scrollable dense content. It should feel technical, not decorative.

## 6. Do's and Don'ts

### Do:
- **Do** preserve the coffee theme tokens: dark roast surfaces, ember accent, latte light mode, and semantic green/orange/red/purple states.
- **Do** use Ember Accent for active navigation, primary action, focus, live status, and evidence.
- **Do** keep layouts dense and operational: rails, panes, lists, tables, filters, compact cards, and status bars.
- **Do** use monospace for receipt-like metadata: commands, ids, counts, token usage, paths, providers, and timestamps.
- **Do** provide reduced-motion fallbacks for pulses, spinners, reveal animations, and panel transitions.
- **Do** make empty states teach the local workflow: how to track a project, reconcile suggestions, add tasks, or inspect usage.

### Don't:
- **Don't** make Taskbean look like a generic SaaS dashboard, obvious AI-template UI, or overdecorated glassy panel system.
- **Don't** use gratuitous gradients, glassmorphism, or decorative blur as the default surface language.
- **Don't** use cute gamified todo-app patterns; personality belongs in copy and small coffee-flavored details, not badges-for-everything.
- **Don't** introduce marketing-scale typography, gradient text, or hero-metric layouts into the app UI.
- **Don't** add colored side-stripe borders to new cards, callouts, alerts, or list items. Use a full tinted background, icon, full border, or semantic chip instead.
- **Don't** spend semantic colors as decoration. Green, orange, red, and purple must communicate state or source.
