# Architecture

## Current Boundary

- `Loom Core/` owns framework runtime metadata, extension and capability registration, capability execution, and cleanup.
- `Loom Host/` is the SillyTavern adapter. It reads public `SillyTavern.getContext()` fields and exposes them as read-only Loom capabilities. Host-specific code stays here so Core does not depend on SillyTavern internals.
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
6. Core validates input before invoking a handler, validates output after it returns, and resolves calls with a structured success/failure envelope.
7. Extensions subscribe to Loom events through Core; the host adapter forwards an allowlisted subset of SillyTavern events as `host:*` Loom events.
8. Unregistering an extension runs its cleanup hooks, then removes its listeners and capabilities.
9. Extensions build interfaces by registering components and mounting declarative view trees through `globalThis.LoomUI`; views and components are torn down by the owning extension's cleanup hook.
10. Extension identity is `author + declaredId` with a deterministic content fingerprint (`contentHash`). Install checks compare a candidate before registration; identity groups mark duplicate installs and content conflicts for display.
11. Loom exposes two entries in SillyTavern: the wand menu (`#extensionsMenu`, converted into a launcher) and an inline drawer in the extension settings panel (`#extensions_settings`). Both open the same panel; the settings drawer relies on ST's global inline-drawer handler.

## Intended Dependency Direction

`Loom Host (SillyTavern adapter) -> Public Loom Core API <- Extensions and Loom UI`

SillyTavern APIs are accessed only inside `Loom Host/`. Core and UI consume the host only through registered capabilities, so future host additions or ST upgrades are confined to the adapter.
