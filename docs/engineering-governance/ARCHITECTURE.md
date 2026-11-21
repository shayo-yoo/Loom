# Architecture

## Current Boundary

- `Loom Core/` owns framework runtime metadata, extension and capability registration, capability execution, and cleanup.
- `Loom Host/` is the SillyTavern adapter. It reads public `SillyTavern.getContext()` fields and exposes them as Loom capabilities. Host-specific code stays here so Core does not depend on SillyTavern internals. It also owns the caller-scoped `settings.*` capabilities and the permission-store adapter, which keeps persisted storage inside the host instead of Core.
- Storage ownership: Core owns the permission grant table and extension state but not where they live. `setPermissionStore` and `setStateStore` take adapters; the host implements both against persisted SillyTavern settings under the reserved `extensionSettings.__loom` root (`grants`, `state[extensionId]`) and flushes with `saveSettingsDebounced()`. A missing host is treated as "nothing persisted yet", never as an error. `settings.*` capabilities remain a separate, caller-scoped channel for user-facing extension settings.
- `Loom UI/` owns the SillyTavern-facing panel adapter and the generic UI system: component registry (`components.js`), built-in components (`builtin-components.js`), pure view-tree validation/mutation (`view-tree.js`), DOM view engine (`views.js`), settings-panel entry (`settings.js`) and small DOM helpers (`dom.js`).
- `manifest.json` at the repository root is the SillyTavern third-party extension descriptor.
- The UI depends on the public `globalThis.Loom` runtime API and exposes its own facade as `globalThis.LoomUI`. The UI does not import Core internals or own business capability execution.
- Business-specific functionality belongs in extensions/scripts, not in Core.

## Runtime Flow

1. SillyTavern discovers the root `manifest.json` in its third-party extension folder.
2. The manifest loads `Loom UI/index.js` and `Loom UI/style.css`.
3. The UI imports the Core runtime and the `Loom Host` adapter using the encoded `Loom%20Core` / `Loom%20Host` paths; the runtime exposes its frozen API as `globalThis.Loom`.
4. Loom UI registers its extension, installs a launcher in ST's `#extensionsMenu` after the menu exists, and reads capability metadata/contracts plus a host snapshot through the public API.
5. Extension scripts and adapters register capabilities with stable extension-scoped IDs and optional input/output schemas.
6. Core validates the caller, then input before invoking a handler, then declared permissions, then output after it returns, and resolves calls with a structured success/failure envelope.
7. Extensions subscribe to Loom events through Core; the host adapter forwards an allowlisted subset of SillyTavern events as `host:*` Loom events.
8. Unregistering an extension runs its cleanup hooks, then removes its listeners, capabilities, grants, and state.
9. Extensions build interfaces by registering components and mounting declarative view trees through `globalThis.LoomUI`; views and components are torn down by the owning extension's cleanup hook. A mounted view is an entry tree: prop updates reuse the DOM node through `update`, child-list changes reconcile by `key` (or index + component) so matched items keep their element and state, and only `setRoot` rebuilds a whole tree. Components own external listeners and post-attach work through `context.onCleanup` / `context.onMount` / `unmount`. A mounted view can be serialized to JSON (handlers stripped, keys kept) and re-mounted, which is the prerequisite for a visual editor.
10. Interactive components are controlled: `modal` and `tabs` report intent through events and change only when the caller updates their props, so the declared tree, `describe()` and the screen cannot disagree.
11. Extension identity is `author + declaredId` with a deterministic content fingerprint (`contentHash`). Install checks compare a candidate before registration; identity groups mark duplicate installs and content conflicts for display.
12. Loom exposes two entries in SillyTavern: the wand menu (`#extensionsMenu`, converted into a launcher) and an inline drawer in the extension settings panel (`#extensions_settings`). Both open the same panel; the settings drawer relies on ST's global inline-drawer handler.
13. Capability permissions are enforced in one place (Core's execution path). Grants are made through the runtime API and surfaced in the panel, which lists every declared permission with a toggle per extension. The grant table is persisted by the host store (`extensionSettings.__loom`); it is an access constraint, not a sandbox.
14. The host adapter maps SillyTavern data into primitive records before returning it (never host objects), truncates long text, and gates only the reads whose content is not already visible in SillyTavern's own UI. Write capabilities are split by blast radius: entry edits (`host.worldinfo.write`), message injection (`host.chat.write`), and whole-book create/remove/import/rename (`host.worldinfo.manage`, which additionally requires the caller to echo the book name). Destructive operations are never inferred from a weaker permission.
15. Whole-book writes go through `saveWorldInfo` when the host exposes it, because SillyTavern keeps an in-memory world cache that the raw `/api/worldinfo/edit` endpoint does not update; deletion has no cache-evicting function, so post-delete reads may be stale until reload. Rename refuses while a character card is bound or the book is globally activated rather than breaking that reference, and migrates only the chat and persona bindings.
15. An extension that is refused a permission can call `requestPermission`; Core emits `core:permission:requested`, and Loom UI renders a consent prompt through the view engine. Requests are Core state (not UI state), so the prompt never owns the queue and disappears when it is empty.
16. `Loom Core/loader.js` sits above identity registration: a manifest declares identity, dependencies, permissions and lifecycle hooks; loading only registers identity, activation checks dependencies and requests permissions before running extension code. Failures are recorded on the extension (`failed` + structured error) instead of thrown, so one broken extension cannot stop the others. The loader reconciles lazily against the registry, so a direct `unregisterExtension` cannot leave stale state.

## Verification

- `npm test` runs the unit suites (`node --test`) against stubbed host contexts. It must stay green without a browser or a running SillyTavern.
- `npm run verify:browser` drives a real headless Chrome over the DevTools protocol against a running SillyTavern: it checks the panel entries, the permission section, grant toggling and persistence across a reload, and the host capabilities against live data. It is not part of `npm test` because it needs both a browser and a running host; it mutates then cleans up its own grants.

## Intended Dependency Direction

`Loom Host (SillyTavern adapter) -> Public Loom Core API <- Extensions and Loom UI`

SillyTavern APIs are accessed only inside `Loom Host/`. Core and UI consume the host only through registered capabilities, so future host additions or ST upgrades are confined to the adapter.
