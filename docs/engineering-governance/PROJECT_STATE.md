# Project State

## Confirmed Baseline

- Loom is a framework project intended to run as an extension in SillyTavern.
- The workspace initially contained only the total requirements, Core requirements, UI requirements, shared interface agreement, and `AGENTS.md`.
- SillyTavern checkout: `D:\1\APP\SillyTavern`, version 1.19.0.
- SillyTavern's existing third-party extension loader discovers manifests under `public/scripts/extensions/third-party`.
- ST `config.yaml` declares port 8100, but no process was listening on 8100 during the first implementation attempt. A previous `.st-run.log` recorded an invocation on port 8000.
- The ST checkout had pre-existing user changes in `Start.bat`, `.st-run.log`, and `酒馆.bat`; these were not modified.

## Current Objective

Deliver an initial Loom runtime and UI extension that can be discovered and enabled through SillyTavern, then iterate toward the framework requirements without embedding business-specific behavior in Core.

## Current Implementation

- Core exposes a small in-memory extension/capability registry, JSON Schema subset validation for declared inputs/outputs, structured execution results, an extension-scoped event bus, per-extension state storage, disposal hooks, and extension-scoped cleanup (runtime 0.7.0).
- Core implements extension identity: `author + declaredId`, deterministic `contentHash` (FNV-1a 64), install pre-checks (`new` / `duplicate` / `conflict`), and identity-group conflict reporting.
- `Loom Host` is an independent SillyTavern adapter registering read-only capabilities (`context.snapshot`, `characters.list`, `worlds.list`, `viewport.get`) and bridging 7 allowlisted host events as `host:*` Loom events.
- `Loom UI` provides a generic interface system: an extension-owned component registry with 12 built-in components, a pure view-tree validator/mutator, and a DOM view engine that supports create, update, append, remove, describe and destroy. Exposed as `globalThis.LoomUI` and as `ui.components` / `ui.views` capabilities.
- Loom has two SillyTavern entries: the wand menu launcher and an inline drawer in the extension settings panel (`#loom_settings_entry`), both opening the same panel.
- UI loads Core and the host adapter, registers itself, shows runtime counts, live host snapshot, viewport size, event listeners, capability contracts, UI component/view summary and identity conflicts, and auto-refreshes on host events.
- The Loom repository root contains the ST extension manifest. ST is intended to reference the workspace through a directory junction so there is one source of truth.

## Open Work / Risks

- Runtime 0.7.0 was verified on port 8100 in Chrome: both entries (wand menu + settings drawer) appear, the settings drawer collapses/expands and opens the panel, `viewport.get` returns live values, and the panel is fluid (440px desktop / full-width mobile) with no horizontal overflow.
- Identity fingerprints are non-cryptographic (`fnv1a64`) and supplied or derived from registrant-provided content; they are not signatures and do not prove authorship or integrity. No online trust/registry, install gate in the ST loader, or migration flow yet.
- No persistence, permission model, or cross-extension version/compatibility negotiation yet. State and events are page-scoped and lost on reload; state sharing requires exposing a capability.
- UI system is an initial slice: no data binding/reactive props, no view serialization or visual editor, no image/media/markdown components, and no per-view style overrides beyond host theme variables. Components are addressed by flat global ids, so extensions must namespace their own.
- Mobile support is currently "mobile-safe, not mobile-optimized": layouts are fluid, tap targets are ≥44px, safe-area insets are respected, grids collapse at ≤768px, and `viewport.get` exposes width/isMobile. Not yet covered: touch gestures (swipe/drag/long-press), on-screen keyboard viewport changes, virtualized long lists, and dedicated phone layouts for dense panels.
- Do not express breakpoints through CSS custom properties inside media queries (browsers ignore them); use literal values and keep them documented.
- Host exposure is read-only; bridged events carry only `{ source, event }` and never host payloads. Chat message contents and user settings are not exposed.
- `characters.list` and `worlds.list` return complete lists with no pagination; large libraries render slowly in UI-driven consumers.
- In-page extension unload does not exist in SillyTavern, so cleanup runs on explicit unregister or page reload.
- SillyTavern has existing user modifications; avoid modifying or reverting them.
