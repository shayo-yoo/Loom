# API Index

## Public Runtime API (`globalThis.Loom`)

Defined in `Loom Core/index.js` (runtime version 0.6.0).

- `registerExtension({ id, name, version?, description?, author?, declaredId?, content?, contentHash? })`: register an extension identity. `id` is the runtime-unique instance id; `author` + `declaredId` form the stable declared identity (`declaredId` defaults to `id`, `author` defaults to none). `content` is fingerprinted into `contentHash` unless a matching `contentHash` is supplied.
- `registerCapability(extensionId, { id, name, description?, input?, output?, execute })`: register a callable capability owned by a registered extension. `execute` must be a function. Optional schemas use the supported JSON Schema subset described below.
- `listExtensions()`: return copies of registered extension metadata, including `author`, `declaredId`, `identityKey`, and `contentHash`.
- `computeContentHash(content)`: deterministic `fnv1a64:...` fingerprint for a string or JSON-like value. This is duplicate-detection metadata, not a signature or security boundary.
- `checkInstall(candidate)`: compare a proposed install (`id`, `name`, `author?`, `declaredId?`, `version?`, `content?`, `contentHash?`) against registered extensions without registering. Resolves to `{ status: 'new'|'duplicate'|'conflict', reason, identity, contentHash, idTaken, matches }`. Same identity with matching hashes is `duplicate`; same identity with different or missing hashes is `conflict`.
- `listIdentityGroups()`: group registered extensions by declared identity, marking each group `single`, `duplicate`, or `conflict`.
- `listIdentityConflicts()`: return only conflict groups for user-facing warnings.
- `listCapabilities(extensionId?)`: return public capability metadata, excluding executable handlers. Schema objects are defensive copies.
- `executeCapability(extensionId, capabilityId, input)`: resolve to `{ success: true, data }` or `{ success: false, error: { code, message, details? } }`; handler exceptions are returned as `EXECUTION_FAILED`, not thrown. Codes include `INVALID_ID`, `CAPABILITY_NOT_FOUND`, `INVALID_INPUT`, `INVALID_OUTPUT`, and `EXECUTION_FAILED`.
- `subscribe(extensionId, eventName, handler, options?)`: listen to a Loom event. The listener belongs to the given registered extension and is removed automatically when that extension is unregistered. `options.once` removes it after the first delivery. Returns an unsubscribe function (`true` when a listener was removed).
- `emit(eventName, payload)`: deliver `payload` to listeners in subscription order, awaiting each. Resolves to `{ delivered, errors }`; listener failures are collected as `{ extensionId, message }` and never abort delivery.
- `listEvents()`: return `[{ name, count }]` sorted by name.
- `addCleanup(extensionId, cleanup)`: register a disposal callback that runs before the extension's listeners and capabilities are removed. Returns a remover function.
- `getState(extensionId, key)` / `setState(extensionId, key, value)` / `deleteState(extensionId, key)` / `listStateKeys(extensionId)`: read and write values inside the extension's own state namespace. State is in-memory, page-scoped, isolated between extensions, and dropped when the extension is unregistered. Sharing state requires exposing it through a capability.
- `unregisterExtension(extensionId)`: run cleanups, then remove the extension's listeners, capabilities, state, and registration. Returns `{ removed, cleanupErrors }`.
- `getRuntimeInfo()`: return Loom version and registry counts (`extensionCount`, `capabilityCount`, `eventCount`, `listenerCount`, `stateKeyCount`).

IDs accept letters, digits, `.`, `_`, and `-`, and must start with a letter or digit. Identity authors and declared ids follow the same rules. Registry state is in-memory and scoped to the browser page.

### Identity and Duplicate Detection

`identityKey` is `<author or anonymous>:<declaredId>`. Two installs can share an identity while having different runtime `id`s (for example, the same extension unpacked into two folders). Content is compared with `contentHash`. Conflicts are reported, never silently dropped; user-modified content is not treated as illegal.

### Supported Schema Subset

Supports `type` (including a type array), `enum`, `const`, `required`, `properties`, `items`, `additionalProperties` (`false` or a schema), `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, and `maxItems`. Unknown schema keywords and malformed schemas are rejected during capability registration. This is a deliberately limited subset, not full JSON Schema; refs, composition, formats, and coercion are not supported.

## Built-in Host Capabilities (`loom-host`)

Registered by `Loom Host/index.js` against public `SillyTavern.getContext()` fields. All take `null` input.

- `context.snapshot`: returns `{ chatId, hasChat, characterName, messageCount, characterCount, worldCount }`.
- `characters.list`: returns `[{ name, avatar }]` in host order.
- `worlds.list`: returns `[string]` world-info names.
- `viewport.get`: returns `{ width, height, pixelRatio, isMobile }`; `isMobile` uses `matchMedia('(max-width: 768px)')` with a width fallback.

These capabilities are read-only and return mapped primitives rather than host objects. When SillyTavern is unavailable (for example outside the browser), calls fail with `EXECUTION_FAILED` and a host-unavailable message.

## Built-in Host Events (`loom-host`)

The adapter forwards an allowlist of SillyTavern events as Loom events, with payload `{ source: 'sillytavern', event: <HOST_EVENT_KEY> }`. Raw host arguments are intentionally not forwarded.

| Loom event | SillyTavern event key |
|---|---|
| `host:chat:changed` | `CHAT_CHANGED` |
| `host:message:sent` | `MESSAGE_SENT` |
| `host:message:received` | `MESSAGE_RECEIVED` |
| `host:character:edited` | `CHARACTER_EDITED` |
| `host:worldinfo:updated` | `WORLDINFO_UPDATED` |
| `host:generation:started` | `GENERATION_STARTED` |
| `host:generation:ended` | `GENERATION_ENDED` |

Only event keys present in the host's `eventTypes` are attached. The bridge detaches when the `loom-host` extension is unregistered.

## Loom UI API (`globalThis.LoomUI`)

Defined in `Loom UI/index.js`, `Loom UI/components.js`, `Loom UI/views.js`, and `Loom UI/view-tree.js`.

- `registerComponent(component)` / `registerComponent(extensionId, component)`: register a component owned by Loom UI or by another registered extension. Component ids are global; extensions should namespace them (for example `myext.chart`).
- `listComponents(extensionId?)`: return descriptors (`id`, `extensionId`, `name`, `description`, `container`, `props`, `events`) without mount functions.
- `createView(options)` / `createView(extensionId, options)`: mount a declarative tree. Options: `{ id?, target?: Element|string, root }`; the target defaults to `document.body`.
- `getView(id)`: return a handle with `setRoot`, `setProps(path, props)`, `setChildren(path, children)`, `appendChild(path, child)`, `remove(path)`, `describe()`, `destroy()`, and `element`.
- `listViews(extensionId?)`: return `{ id, extensionId, root }` descriptions.
- `destroyAllViews(extensionId?)`: remove all views, optionally scoped to one extension.

Views and components are removed automatically when their owning extension is unregistered from Loom Core.

### Node Shape

A node is a shorthand string (rendered as `text`) or `{ component, props?, children?, on? }`. `children` are only allowed on components declared as `container`. Event handlers declared in `on` receive `{ event, payload, path, viewId, extensionId }`; handlers are invoked with isolation so a throwing handler cannot break rendering.

### Built-in Components

`text`, `button`, `input`, `toggle`, `select`, `card`, `row`, `column`, `grid`, `divider`, `list`, `badge`. Props are validated by type and required flag; unknown props are rejected. Text values are assigned via `textContent`, never injected as HTML.

`grid` accepts `columns` (number), `responsive` (boolean, default `true`) and `gap`. When `responsive` is on, the grid collapses to a single column at viewport widths ≤ 768px; columns are applied through the `--loom-columns` CSS variable so the stylesheet can override them in media queries.

### Layout and Mobile Constraints

- Panel/drawer widths use fluid values (`min(440px, 100%)`), never fixed pixel widths, so narrow viewports stay usable.
- Interactive controls keep a minimum 44×44px tap target and use `touch-action: manipulation`.
- The panel body is a single column flex container with a sticky header; content scrolls inside it.
- Long identifiers and contract JSON wrap (`overflow-wrap: anywhere`) instead of forcing horizontal scroll.
- Breakpoints are literal values in CSS (media queries cannot read CSS custom properties); currently 768px for grids and 600px for panel chrome.
- No hover-only interactions and no fixed-position coordinates are required by components.

### Settings Entry

The extension settings panel (`#extensions_settings`) contains an inline drawer `#loom_settings_entry` with runtime counts, conflict count, host status and a button that opens the Loom panel. The drawer relies on SillyTavern's global `.inline-drawer-toggle` handler; do not add a second click listener or the drawer will toggle twice.

### UI Capabilities

- `loom-ui:ui.components` (null input): list registered component descriptors.
- `loom-ui:ui.views` (null input): list active view descriptions.
