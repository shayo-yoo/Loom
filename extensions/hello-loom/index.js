/**
 * Hello Loom — the minimal Loom extension.
 *
 * Package layout (this is the whole contract):
 *   manifest.json   id / name / version / entry, plus optional dependencies and permissions
 *   index.js        default export: { activate?, deactivate? } or a factory returning it
 *
 * The identity comes from `manifest.json`; the loader merges the module's hooks
 * into that manifest. Register everything you need in `activate` and undo it in
 * `deactivate` — extension unload calls both.
 */
const CAPABILITY_ID = 'hello.greet';
let calls = 0;

export default {
    activate({ id }) {
        const runtime = globalThis.Loom;
        if (!runtime) return;

        // Capabilities are registered under the extension's own id; Core rejects
        // another extension registering on its behalf.
        runtime.registerCapability(id, {
            id: CAPABILITY_ID,
            name: 'Say hello',
            description: 'Returns a greeting and counts how often it was called.',
            input: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
                additionalProperties: false,
            },
            output: {
                type: 'object',
                required: ['message', 'calls'],
                properties: { message: { type: 'string' }, calls: { type: 'integer', minimum: 0 } },
                additionalProperties: false,
            },
            execute: input => {
                calls += 1;
                // State is the extension's own scratch space; a host store attached
                // to Core persists cloneable values across reloads.
                runtime.setState(id, 'calls', calls);
                return { message: `Hello, ${input.name}!`, calls };
            },
        });

        runtime.setState(id, 'activatedAt', new Date().toISOString());
    },

    deactivate() {
        // Capabilities and state are dropped by Core when the extension unloads;
        // a deactivation that keeps the extension registered only needs to stop
        // its own bookkeeping.
        calls = 0;
    },
};
