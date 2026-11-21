# API Index

## Public Runtime API (`globalThis.Loom`)

Defined in `Loom Core/index.js` (runtime version 0.18.0).

- `registerExtension({ id, name, version?, description?, author?, declaredId?, content?, contentHash? })`: register an extension identity. `id` is the runtime-unique instance id; `author` + `declaredId` form the stable declared identity (`declaredId` defaults to `id`, `author` defaults to none). `content` is fingerprinted into `contentHash` unless a matching `contentHash` is supplied.
- `registerCapability(extensionId, { id, name, description?, input?, output?, permissions?, execute })`: register a callable capability owned by a registered extension. `execute` must be a function. `permissions` is an optional array of permission names the **caller** must hold; duplicates collapse and the declaration itself never grants anything. Optional schemas use the supported JSON Schema subset described below.
- `listExtensions()`: return copies of registered extension metadata, including `author`, `declaredId`, `identityKey`, and `contentHash`.
- `computeContentHash(content)`: deterministic `fnv1a64:...` fingerprint for a string or JSON-like value. This is duplicate-detection metadata, not a signature or security boundary.
- `checkInstall(candidate)`: compare a proposed install (`id`, `name`, `author?`, `declaredId?`, `version?`, `content?`, `contentHash?`) against registered extensions without registering. Resolves to `{ status: 'new'|'duplicate'|'conflict', reason, identity, contentHash, idTaken, matches }`. Same identity with matching hashes is `duplicate`; same identity with different or missing hashes is `conflict`.
- `listIdentityGroups()`: group registered extensions by declared identity, marking each group `single`, `duplicate`, or `conflict`.
- `listIdentityConflicts()`: return only conflict groups for user-facing warnings.
- `listCapabilities(extensionId?)`: return public capability metadata, excluding executable handlers. Schema objects are defensive copies; each descriptor carries its declared `permissions`.
- `executeCapability(extensionId, capabilityId, input, options?)`: resolve to `{ success: true, data }` or `{ success: false, error: { code, message, details? } }`; handler exceptions are returned as `EXECUTION_FAILED`, not thrown. `options.caller` names the calling extension and defaults to the capability owner (a self-call); cross-extension calls should pass it explicitly. The handler receives `(input, context)` with `{ caller, target, capabilityId, capabilityPermissions, hasPermission(permission) }`.
- `grantPermission(extensionId, permission)` / `revokePermission(extensionId, permission)` / `checkPermission(extensionId, permission)` / `listPermissions(extensionId?)`: manage the grant table. `listPermissions()` returns `[{ extensionId, permissions: string[] }]` sorted; grants are dropped when the extension is unregistered. See "Permissions" below for the boundary.
- `requestPermission(extensionId, permission, { reason? })`: ask for a grant instead of failing silently. Resolves to `{ requestId, status }` where `status` is `pending`, `granted` (already held — no prompt), and `requestId` is `null` in that case. Requesting the same pair twice reuses the open request instead of stacking prompts. Asking never grants anything. `reason` is truncated to 500 characters. Emits `core:permission:requested` with `{ request: { id, extensionId, permission, reason, requestedAt } }`.
- `listPermissionRequests()`: return the open requests as `[{ id, extensionId, permission, reason, requestedAt }]` sorted by extension then permission.
- `resolvePermissionRequest(requestId, { approved })`: answer a request. Returns `{ requestId, status }` with `status` `granted`, `denied`, or `unknown` (a stale id from a surface that raced another one is reported, not thrown). Granting goes through the same path as `grantPermission`, so the decision is persisted by the store. Emits `core:permission:resolved` with `{ requestId, extensionId, permission, status }`.
- `setPermissionStore(store | null)`: attach an optional persistent store for the grant table. `store` must provide `load()` (returning a grant snapshot) and `save(grants)`; Core owns the table and the store only decides where the snapshot lives. Attaching a store restores the snapshot: grants for already-registered extensions apply immediately, the rest apply when their extension registers, so install order does not matter. Malformed entries are dropped, and a throwing store is reported but never breaks the in-memory table. Passing `null` detaches without clearing the table.

### Extension Loading and Lifecycle

`Loom Core/loader.js` adds a manifest-driven layer on top of `registerExtension`. Loading and activation are deliberately separate: loading only validates and registers identity, activation runs extension code.

- `loadExtension(manifest)`: validate `{ id, name, version?, description?, author?, declaredId?, entry?, dependencies?, permissions?, activate?, deactivate?, content? }` and register the identity. Throws `TypeError`/`Error` for a malformed manifest, a duplicate id, or a self-dependency. Returns a state snapshot `{ id, name, version, state, entry, dependencies, permissions, error }` with `state: 'loaded'`. Emits `core:extension:loaded`.
- `activateExtension(id)`: check dependencies (`active` or `unmanaged` — see below), request declared permissions, then run `activate({ id, name, version })`. Returns the snapshot with `state: 'active'`. Failures never throw: the extension becomes `failed` with an `error` object (`DEPENDENCY_MISSING` with `details.missing`, or `ACTIVATION_FAILED`), the hook is skipped, and other extensions are unaffected. Activating an already-active extension is idempotent; a failed one can be retried. Emits `core:extension:activated` / `core:extension:failed`.
- A dependency is satisfied when it is `active` or `unmanaged`. `unmanaged` means the extension was registered through `registerExtension` by bootstrap code (the host adapter and UI do this), so its setup already ran and it can never become `active` through the loader. A managed dependency must be `active`: `loaded`, `inactive` and `failed` are all unmet.
- `deactivateExtension(id)`: run `deactivate({ id, name, version })` and mark `inactive`. A throwing hook is recorded as `DEACTIVATION_FAILED`; the extension is still deactivated and stays registered (capabilities remain callable) until unloaded. Emits `core:extension:deactivated`.
- `unloadExtension(id)`: deactivate if active, then `unregisterExtension` (cleanups, capabilities, grants, state, listeners). Emits `core:extension:unloaded`. Returns `{ removed, cleanupErrors }`.
- `listExtensionStates()` / `getExtensionState(id)`: every registered extension with its lifecycle state, including `unmanaged` for extensions registered directly through `registerExtension` (the host adapter and UI do this). `getExtensionState` returns `null` for an unknown id.
- `startExtensions()`: activate every loaded extension in dependency order (dependencies first; independent extensions in load order). Returns `{ activated, failed }`, where `failed` entries are `{ id, error }`. A dependency cycle leaves its members `failed` with `DEPENDENCY_MISSING` instead of hanging. Already-active extensions are reported as activated (idempotent).
- `importExtension(specifier, { activate?, manifest? })`: dynamically `import()` a module, take its manifest (default export object, default export function returning one, `manifest` named export, or `options.manifest`), register it and — unless `activate: false` — activate it. Import, factory, manifest and activation problems are returned as a structured failure (`IMPORT_FAILED`, `MANIFEST_FAILED`, `MANIFEST_MISSING`, `MANIFEST_INVALID`) with `state: 'failed'`, never thrown: one broken package must not take the boot sequence down. The result carries the `specifier` it came from.
- Declared `permissions` are **requested**, not granted: activation raises consent prompts (`reason: 扩展 <name> 在清单中声明了该权限`). A permission request failure is recorded on the extension but never blocks activation.
- The loader reconciles lazily: if an extension is unregistered through Core directly, its manifest record is dropped on the next lifecycle call, so the two registries cannot drift.

Lifecycle events: `core:extension:loaded`, `core:extension:activated`, `core:extension:failed`, `core:extension:deactivated`, `core:extension:unloaded`.
- Checks run in a fixed order: ids → capability lookup → caller registration → input schema → declared permissions → handler → output schema. An omitted `input` argument is normalised to `null` before validation, because capability contracts are JSON and a missing argument means "no input". Codes include `INVALID_ID`, `CAPABILITY_NOT_FOUND`, `CALLER_NOT_FOUND`, `INVALID_INPUT`, `PERMISSION_DENIED` (with `details.missing`), `INVALID_OUTPUT`, and `EXECUTION_FAILED`. A thrown error carrying a string `code` keeps that code in the envelope.
- `subscribe(extensionId, eventName, handler, options?)`: listen to a Loom event. The listener belongs to the given registered extension and is removed automatically when that extension is unregistered. `options.once` removes it after the first delivery. Returns an unsubscribe function (`true` when a listener was removed).
- `emit(eventName, payload)`: deliver `payload` to listeners in subscription order, awaiting each. Resolves to `{ delivered, errors }`; listener failures are collected as `{ extensionId, message }` and never abort delivery.
- `listEvents()`: return `[{ name, count }]` sorted by name.
- `addCleanup(extensionId, cleanup)`: register a disposal callback that runs before the extension's listeners and capabilities are removed. Returns a remover function.
- `setState(extensionId, key, value)` / `getState` / `deleteState` / `listStateKeys(extensionId)`: read and write values inside the extension's own state namespace. State is isolated between extensions and dropped when the extension is unregistered; it is persisted only when a state store is attached (see `setStateStore`). Sharing state requires exposing it through a capability.
- `setStateStore(store | null)`: attach an optional persistent store for extension state. `store` must provide `load(extensionId) → object|null`, `save(extensionId, snapshot)` and `remove(extensionId)`. Core keeps namespace isolation; the store only sees one extension's snapshot. Attaching restores state for registered extensions, and extensions that register later load their own snapshot, so boot order does not matter. Only values that survive `structuredClone` are persisted — live values (functions, DOM nodes) stay usable in memory and are skipped from the snapshot with a warning. A live value is never overwritten by a restored snapshot. Store failures are reported and never break the in-memory namespace; deleting the last key removes the stored namespace rather than saving an empty object.
- `unregisterExtension(extensionId)`: run cleanups, then remove the extension's listeners, capabilities, state, and registration. Returns `{ removed, cleanupErrors }`.
- `getRuntimeInfo()`: return Loom version and registry counts (`extensionCount`, `activeExtensionCount`, `failedExtensionCount`, `capabilityCount`, `eventCount`, `listenerCount`, `stateKeyCount`, `grantedPermissionCount`, `permissionRequestCount`, `permissionStoreAttached`, `stateStoreAttached`).

IDs accept letters, digits, `.`, `_`, and `-`, and must start with a letter or digit. Identity authors and declared ids follow the same rules. Permission names also accept `:`. Registry state is in-memory and scoped to the browser page.

### Permissions

A capability declares the permissions its caller must hold; Core enforces them centrally before the handler runs, so a capability cannot accidentally execute without the grant it advertised. Grants are explicit, per extension, and never implied by a declaration or by registration.

The grant table is an **access constraint, not a sandbox**. Every Loom script shares the page realm, so a script can call `grantPermission` for itself or reach `SillyTavern.getContext()` directly; Loom does not attempt to defend against hostile in-page code (see the Core requirements' non-goal of a full security system). What it does provide: a visible, revocable consent record that the UI can present, plus a single enforcement point so accidental cross-extension writes are rejected with `PERMISSION_DENIED`.

Grants persist when a store is attached. `Loom Host` installs one backed by SillyTavern's persisted settings, storing the snapshot under the reserved `extensionSettings.__loom.grants` key; extension ids cannot start with `_`, so the root cannot collide with a caller namespace. Without a host (or without a store), grants last only for the page lifetime. Persisting Core *state* is still not implemented: state remains page-scoped.

An extension that needs a permission should call `requestPermission` rather than let a call fail with `PERMISSION_DENIED`. Loom UI subscribes to `core:permission:requested` and renders a consent prompt (see below), so the user sees *why* a grant is wanted instead of having to find the panel.

### Identity and Duplicate Detection

`identityKey` is `<author or anonymous>:<declaredId>`. Two installs can share an identity while having different runtime `id`s (for example, the same extension unpacked into two folders). Content is compared with `contentHash`. Conflicts are reported, never silently dropped; user-modified content is not treated as illegal.

### Supported Schema Subset

Supports `type` (including a type array), `enum`, `const`, `required`, `properties`, `items`, `additionalProperties` (`false` or a schema), `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, and `maxItems`. Unknown schema keywords and malformed schemas are rejected during capability registration. This is a deliberately limited subset, not full JSON Schema; refs, composition, formats, and coercion are not supported.

## Built-in Host Capabilities (`loom-host`)

Registered by `Loom Host/index.js` against public `SillyTavern.getContext()` fields.

Read capabilities (input `null` unless stated):

- `context.snapshot`: returns `{ chatId, hasChat, characterName, messageCount, characterCount, worldCount }`.
- `characters.list`: returns `[{ name, avatar }]` in host order.
- `characters.get` (`{ name }`, matched against name or avatar filename, case-insensitive): returns `{ name, avatar, description, personality, scenario, firstMessage, exampleMessages, creatorNotes, tags }`, or `null` when absent.
- `worlds.list`: returns `[string]` world-info names.
- `worlds.entries` (`{ name, limit? }`, limit 1–200, default 200): loads the world book through `getContext().loadWorldInfo()` and returns `[{ uid, comment, keys, secondaryKeys, content, enabled, constant, selective, order, truncated }]` sorted by `order` then `uid`. Missing books and books without entries return `[]`; a host without `loadWorldInfo` fails with `HOST_UNSUPPORTED`. Entry `content` is truncated at 2000 chars with `truncated: true`.
- `chat.messages` (`{ limit?, offset? }` or `null`; limit 1–100 default 20, offset counts back from the newest message): returns `[{ index, name, isUser, isSystem, text, truncated }]` in reading order (oldest first); `index` is the absolute chat position and `text` is truncated at 2000 chars. **Requires `host.chat.read`** — chat content is the user's private conversation, so it is the one gated read.
- `viewport.get`: returns `{ width, height, pixelRatio, isMobile }`; `isMobile` uses `matchMedia('(max-width: 768px)')` with a width fallback.

Caller-scoped settings capabilities read and write the caller's own namespace inside SillyTavern's persisted `extensionSettings`, keyed by the caller's Loom extension id:

- The namespace is `extensionSettings[caller]`; a caller cannot read or write another extension's namespace. Writes call `saveSettingsDebounced()`, so values survive a reload. `settings.get` and `settings.keys` never create an empty namespace.
- Keys must be 1–128 characters and may not be `__proto__`, `prototype`, or `constructor`. Values must be structured-cloneable; otherwise the call fails with `INVALID_INPUT`.
- A caller id that is not a valid extension id fails with `CALLER_REQUIRED`; a missing host fails with `HOST_UNAVAILABLE`.

Gating rationale: library assets (world books, character cards) are readable without a grant because SillyTavern already displays them in its own UI; chat content is not on screen by default in a machine-readable form and is gated. Read capabilities return mapped primitives and never expose host objects (`extra`, `swipes`, API keys).

Write capabilities (the read/write split required by Core requirements §5):

| Capability | Input | Output | Required permission |
|---|---|---|---|
| `settings.set` | `{ key, value }` | `{ key, written }` | `host.settings.write` |
| `settings.remove` | `{ key }` | `{ key, removed }` | `host.settings.write` |
| `worlds.entry.update` | `{ name, uid, patch }` | `{ name, uid, updated }` | `host.worldinfo.write` |
| `worlds.entry.create` | `{ name, entry? }` | `{ name, uid, created }` | `host.worldinfo.write` |
| `worlds.entry.remove` | `{ name, uid }` | `{ name, uid, removed }` | `host.worldinfo.write` |
| `chat.append` | `{ text, type? }` | `{ appended, type, index }` | `host.chat.write` |
| `worlds.create` | `{ name }` | `{ name, created }` | `host.worldinfo.manage` |
| `worlds.remove` | `{ name, confirm }` | `{ name, removed }` | `host.worldinfo.manage` |
| `worlds.export` | `{ name }` | `{ name, entries, data }` | — |
| `worlds.import` | `{ name, data }` | `{ name, entries, created }` | `host.worldinfo.manage` |
| `worlds.rename` | `{ name, to, confirm }` | `{ from, to, migrated }` | `host.worldinfo.manage` |

Data movement and renaming:

- `worlds.export` returns a **detached copy of the host's raw book object**, not the mapped subset `worlds.entries` exposes, so import can round-trip fields Loom does not model. It is ungated like the entry reads; the entry text it contains is already readable through `worlds.entries`.
- `worlds.import` refuses an existing name (`WORLD_EXISTS`) and validates the payload before any request: `entries` object, entry objects, no reserved uid, ≤ 5000 entries and ≤ 5 MB. What reaches the host is re-serialised plain JSON.
- `worlds.rename` requires `confirm` to echo the current name, refuses a case-insensitive no-op and an existing target, and **refuses while the book is referenced in a way it cannot migrate** (`WORLD_IN_USE`): a character card bound to it (`details.characters`) or a global activation in SillyTavern's `#world_info` dropdown (`details.selection`). Card links would need card writing; the activation dropdown is rebuilt by the host after a rename without guaranteeing the renamed option exists, so retargeting it is not reliable — the user deactivates, renames, reactivates. References it *can* migrate are migrated: the current chat's `chat_metadata.world_info` and `power_user.persona_description_lorebook`, reported in `migrated`. Copy-then-delete: the original survives a failed copy.
- **Host cache:** writes go through `context.saveWorldInfo(name, data, true)` when available, because the raw endpoint writes the file but leaves SillyTavern's in-memory world cache stale (a deleted-then-recreated book used to read back its old entries). Deletion still goes through `/api/worldinfo/delete`, which cannot evict that cache — so reads immediately after a delete may return cached data until reload.

Whole-book lifecycle (destructive, hence a separate permission):

- `worlds.create` makes an empty book. An existing name fails with `WORLD_EXISTS` before any request, so "create" can never clobber. After the host call the adapter refreshes the world list and requires the book to appear (`WORLD_CREATE_FAILED` otherwise).
- `worlds.remove` requires `confirm` to repeat `name` exactly; a mismatch fails with `CONFIRMATION_REQUIRED` and makes no request. A missing book is `WORLD_NOT_FOUND`; a deletion that leaves the book listed is `WORLD_REMOVE_FAILED`. Deletion is irreversible — there is no soft delete.
- Neither operation has a `getContext()` function, so the adapter calls SillyTavern's own `/api/worldinfo/edit` and `/api/worldinfo/delete` with `getRequestHeaders()`. This is a documented exception to the `getContext()`-only rule; reads are unaffected by endpoint changes.
- `host.worldinfo.manage` is separate from `host.worldinfo.write`: granting entry edits never implies book deletion.

`chat.append` writes one **system message** into the open chat:

- `type` is an allowlist (`narrator` default, `comment`, `generic`) mapped onto SillyTavern's own `sendSystemMessage`, because that is the only stable writing function the host exposes; fabricating a chat entry would bypass its rendering and bookkeeping. Unknown types fail with `INVALID_INPUT`; `text` is 1–4000 characters.
- A chat must be open: no chat id and an empty chat buffers to `NO_CHAT` instead of writing nowhere.
- `sendSystemMessage` renders but does not save, so the handler calls `saveChat?.()` afterwards; a message that is not persisted would silently disappear on the next reload.
- **Rollback is mandatory.** SillyTavern pushes the message *before* rendering it, so a render failure (or an unsupported type on some builds) can leave a half-written entry. The handler catches the throw, pops everything it added, and reports `HOST_UNSUPPORTED`. A failed append never mutates the chat.
- Known host hazard: when the current chat already contains a malformed entry, SillyTavern's own rendering path can throw `Cannot read properties of undefined (reading 'is_user')`. That is recorded rather than worked around — the capability reports it and leaves the chat untouched.

`worlds.entry.update` is the world-book write contract:

- The caller patches fields (`content`, `comment`, `keys`, `secondaryKeys`, `enabled`, `constant`, `selective`, `order`) and never supplies a whole book. Unknown patch fields fail with `INVALID_INPUT` instead of being ignored.
- The adapter re-reads the book, applies the patch, and saves with `immediately = true`, so a resolved success means SillyTavern accepted the write rather than queued a debounce.
- **Last write wins.** There are no version tokens yet, so a concurrent editor can overwrite a field the caller did not patch. A future revision should add an entry revision token before multi-editor flows are supported.
- `enabled` maps onto SillyTavern's inverted `disable` flag; fields outside the patch are untouched.
- An empty patch returns `updated: []` without touching the book. A missing or empty book fails with `WORLD_NOT_FOUND` (SillyTavern answers an unknown name with no entries), a missing entry with `ENTRY_NOT_FOUND`, and a host without `loadWorldInfo`/`saveWorldInfo` with `HOST_UNSUPPORTED`.

`worlds.entry.create` / `worlds.entry.remove` complete the entry lifecycle:

- `create` requires the name to be in the host's world list (`getWorldInfoNames()`), because saving into an unknown name would silently create a new book file — a typo must fail with `WORLD_NOT_FOUND`, not produce a stray book. An existing but *empty* book is a valid target.
- The uid is the **first free integer from 0**, mirroring SillyTavern's own `getFreeWorldEntryUid` and its "new entry" button (not max+1, so a freed uid is reused). Both the object key and the entry's `uid` field are treated as reserved, since imported books can disagree.
- New entries start from a default field set that mirrors SillyTavern 1.19.0's `newWorldInfoEntryTemplate` (this duplication is deliberate: the adapter does not import host internals, so the table must be revisited on a host upgrade). Caller-supplied `entry` fields override the defaults; unknown fields fail with `INVALID_INPUT`.
- `remove` deletes by uid and fails with `ENTRY_NOT_FOUND` / `WORLD_NOT_FOUND`. Both write immediately (`immediately = true`) and are gated behind `host.worldinfo.write`.

All host capabilities return mapped primitives rather than host objects. When SillyTavern is unavailable (for example outside the browser), calls fail with a structured host-unavailable error.

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
- `serializeView(viewId)` / `serializeNode(node)`: plain JSON-compatible data for a mounted view (or any node), with event handlers stripped. Throws for an unknown view id.
- `createViewFromSerialized(serialized, options?)` / `createViewFromSerialized(extensionId, serialized, options?)`: mount a handler-free tree produced by serialization. Rejects any `on` at any level, so a serialized resource cannot smuggle behaviour in.
- `getView(id)`: return a handle with `setRoot`, `setProps(path, props)`, `setChildren(path, children)`, `appendChild(path, child)`, `remove(path)`, `describe()`, `serialize()`, `destroy()`, and `element`.
- `listViews(extensionId?)`: return `{ id, extensionId, root }` descriptions.
- `destroyAllViews(extensionId?)`: remove all views, optionally scoped to one extension.

Views and components are removed automatically when their owning extension is unregistered from Loom Core.

### Node Shape

A node is a shorthand string (rendered as `text`) or `{ component, props?, children?, on?, key? }`. `children` are only allowed on components declared as `container`. `key` is an optional string or finite number that identifies a child across updates (siblings must not repeat a key). Event handlers declared in `on` receive `{ event, payload, path, viewId, extensionId }`; handlers are invoked with isolation so a throwing handler cannot break rendering.

### Component Lifecycle

`mount(props, context)` receives a context with `{ emit, path, extensionId }` plus two registration hooks:

- `context.onCleanup(fn)` — teardown that runs when the node leaves the DOM: view destroyed, root replaced, or a structural change rebuilt the tree. Cleanups run **most recent first**, before the component's `unmount`, and failures are reported without stopping the rest. This is what lets a component own document-level listeners without leaking them.
- `context.onMount(fn)` — work that needs a *connected* element (focus moves, size measurement). The engine runs it after the tree is attached, parent-first, once per mount. It does not re-run on in-place prop updates, and does re-run after a structural rebuild.

A component may declare `unmount(element, props, context)` for teardown that needs the element; it runs after cleanups. Components without `update` fall back to a rebuild on `setProps`, which disposes and re-mounts them, so cleanups and mount callbacks run again.

`components.js` validates and stores `mount`, `update` and `unmount`; descriptors never expose handlers.

### Built-in Components

`text`, `button`, `input`, `toggle`, `select`, `card`, `row`, `column`, `grid`, `divider`, `list`, `badge`, plus (0.14.0) `image`, `tabs`, `modal`, `menu`. Props are validated by type and required flag; unknown props are rejected. Text values are assigned via `textContent`, never injected as HTML.

`grid` accepts `columns` (number), `responsive` (boolean, default `true`) and `gap`. When `responsive` is on, the grid collapses to a single column at viewport widths ≤ 768px; columns are applied through the `--loom-columns` CSS variable so the stylesheet can override them in media queries.

New in 0.14.0:

- `image`: `src` (required), `alt` (required), `caption`, `fit` (`cover`/`contain`). Only `http:`, `https:`, `data:` and `blob:` sources are accepted; anything else throws at mount **and** at update (an update that throws rolls the tree back). Emits `load` / `error` with `{ src }`; rendered with `loading="lazy"`.
- `tabs`: container, `labels` (string array) with children in label order, `active` (default 0). **Controlled**, like `modal`: clicking a tab or pressing an arrow/Home/End key emits `change` with `{ index }` and moves focus, but the visible panel only changes when the caller passes a new `active`. This keeps `describe()`/`serialize()` truthful about what is on screen instead of tracking a local selection the tree does not know about.
- `modal`: container, `open` (required), `title`, `closable` (default true). Controlled: the close button, backdrop and Escape only emit `close`, the caller must set `open: false`. Escape is handled by a **document-level** listener released through `onCleanup`, so it works regardless of where focus sits and cannot outlive the view. Opening moves focus into the dialog (via `onMount`, so it works when the modal is created already open) and closing restores focus to the opener when it is still connected. Tab/Shift+Tab wrap between the dialog's focusable controls.
- `card`: an empty `title`/`subtitle` is hidden rather than left as a blank node.
- `menu`: `items` (`[{ id, label }]`), emits `select` with `{ id }`.

### Partial Updates, Reconciliation and Serialization

- `setProps(path, props)` calls the component's `update` when it declares one, so the DOM node is reused and event handlers stay attached. A component without `update` gets **only its own subtree** rebuilt, not the whole view. If `update` throws, the tree props roll back so state and DOM cannot disagree.
- `setChildren(path, children)` reconciles instead of rebuilding: children are matched by `key` (or, when unkeyed, by index + component id). Matched children keep their element, listeners and internal state; only inserted children are mounted and only removed children are disposed (leaves first, then `onCleanup`, then `unmount`). Matching children whose props changed are updated in place; a changed component id at the same position is remounted.
- `appendChild` mounts just the new child; `remove` disposes just that subtree.
- A reorder moves nodes in the DOM, which blurs a focused element even though the object is reused, so focus and text selection are captured by element identity around reconciliation and restored afterwards.
- `setRoot` replaces the whole tree; that is the one path that legitimately rebuilds everything, and it restores focus/selection/scroll by path.
- A component `mount` may return `{ element, content }`; when `content` is a function `(index) => Element`, each child gets its own container (used by `tabs` for panels).
- Serialization drops handlers and non-JSON prop values (functions, symbols, `undefined`) but **keeps `key`**, so a re-mounted list keeps its identity semantics. View id, target and extensionId are not part of the tree and must be supplied again on mount.

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

### Extension List

The panel renders `#loom_extensions` from `listExtensionStates()`: name, id, version, lifecycle badge (已装载 / 已激活 / 已停用 / 失败 / 直接注册), declared dependencies and permissions, and the recorded error for a failed extension. It refreshes from the `core:extension:*` lifecycle events, so a load or activation failure is visible without reopening the panel. `#loom_extension_state_count` summarises active/failed counts.

### Permission Section
The panel renders a permission list (`#loom_permissions`) built by `Loom UI/permissions.js` from `listCapabilities()`, `listExtensions()` and `listPermissions()`. Each declared permission shows the capabilities that require it and one toggle per registered extension; toggling calls `grantPermission` / `revokePermission` through the runtime API, reading the live grant state from Core at click time rather than trusting the rendered attribute (a grant may have changed elsewhere). The builders (`summarizePermissions`, `buildPermissionSectionHtml`, `countGranted`) are pure and unit tested; the panel binds a single delegated click listener to the stable container so re-rendering does not lose handlers. Capability entries also list their declared permissions.

### Consent Prompt

Open requests raise a prompt in `#loom_consent` (fixed bottom-right on desktop, full width on narrow screens). `Loom UI/consent.js` joins requests with extension names, the capabilities declaring each permission, and a one-line summary of what those capabilities send and return (`describeContract`, e.g. `输入 { name, uid, patch } → 输出 数组<string>`), then builds a declarative node tree that the panel mounts through `LoomUI.createView`. Approve/deny call `resolvePermissionRequest`; the prompt is re-rendered from Core state on every request/resolution, so it holds no state of its own and disappears when the queue is empty. `summarizeRequests`, `describeContract` and `buildConsentNodes` are pure and unit tested.
