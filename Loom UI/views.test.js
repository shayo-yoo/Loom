import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerExtension, unregisterExtension } from '../Loom%20Core/index.js';
import { registerComponent, resetComponents } from './components.js';
import { BUILTIN_COMPONENTS } from './builtin-components.js';
import { createEvent, installDomFixture } from './dom-fixture.js';
import {
    createView,
    createViewFromSerialized,
    listViews,
    resetViews,
    serializeView,
} from './views.js';

const owner = 'views-test-owner';

let dom;
let counterUpdates = 0;
let lifecycleLog = [];

function registerTestComponents() {
    for (const component of BUILTIN_COMPONENTS) registerComponent(owner, component);
    registerComponent(owner, {
        id: 'counter',
        name: 'Counter',
        props: {
            value: { type: 'number', default: 0 },
            label: { type: 'string', default: '' },
        },
        mount: props => {
            const element = document.createElement('div');
            element.className = 'counter';
            element.textContent = `${props.label}:${props.value}`;
            return element;
        },
        update: (element, props) => {
            counterUpdates += 1;
            element.textContent = `${props.label}:${props.value}`;
        },
    });
    // Deliberately declares no update, to exercise the rebuild fallback.
    registerComponent(owner, {
        id: 'plainbox',
        name: 'Plain box',
        props: { label: { type: 'string', default: '' } },
        mount: props => {
            const element = document.createElement('div');
            element.className = 'plainbox';
            element.textContent = props.label;
            return element;
        },
    });
    // Lifecycle probe: records cleanup/unmount calls with its label.
    registerComponent(owner, {
        id: 'lifecycle',
        name: 'Lifecycle probe',
        container: true,
        props: { label: { type: 'string', default: '' } },
        mount: (props, context) => {
            const element = document.createElement('div');
            element.className = 'lifecycle';
            element.textContent = props.label;
            context.onCleanup(() => { lifecycleLog.push(`cleanup:${props.label}`); });
            context.onCleanup(() => { lifecycleLog.push(`cleanup2:${props.label}`); });
            return element;
        },
        update: (element, props) => { element.textContent = props.label; },
        unmount: (element, props) => { lifecycleLog.push(`unmount:${props.label}`); },
    });
}

beforeEach(() => {
    dom = installDomFixture();
    counterUpdates = 0;
    lifecycleLog = [];
    registerExtension({ id: owner, name: 'Views Test Owner' });
    registerTestComponents();
});

afterEach(() => {
    resetViews();
    unregisterExtension(owner);
    resetComponents();
    dom.uninstall();
});

test('setProps updates a component in place instead of rebuilding the tree', () => {
    const view = createView(owner, {
        id: 'v-update',
        root: {
            component: 'column',
            props: { gap: 4 },
            children: [
                { component: 'counter', props: { value: 1, label: 'n' } },
                { component: 'counter', props: { value: 2, label: 'n' } },
            ],
        },
    });

    const root = view.element;
    const first = root.children[0];
    const second = root.children[1];

    view.setProps([0], { value: 9 });

    assert.equal(counterUpdates, 1, 'the declared update ran exactly once');
    assert.equal(view.element, root, 'the view root was not replaced');
    assert.equal(root.children[0], first, 'the updated element was not replaced');
    assert.equal(root.children[1], second, 'sibling elements were not touched');
    assert.equal(first.textContent, 'n:9');
    assert.deepEqual(view.describe().children[0].props, { value: 9, label: 'n' });
});

test('setProps keeps event handlers usable after an in-place update', () => {
    let clicks = 0;
    const view = createView(owner, {
        id: 'v-update-events',
        root: {
            component: 'button',
            props: { label: 'Before' },
            on: { click: () => { clicks += 1; } },
        },
    });

    view.setProps([], { label: 'After' });
    assert.equal(view.element.textContent, 'After');
    view.element.dispatchEvent(createEvent('click'));
    assert.equal(clicks, 1, 'the original handler survived the local update');
});

test('setProps falls back to rebuilding only the affected subtree', () => {
    const view = createView(owner, {
        id: 'v-fallback',
        root: {
            component: 'column',
            children: [{ component: 'plainbox', props: { label: 'a' } }],
        },
    });

    const previousRoot = view.element;
    const previousChild = previousRoot.children[0];

    view.setProps([0], { label: 'b' });

    assert.equal(view.element, previousRoot, 'the root element is preserved');
    assert.notEqual(view.element.children[0], previousChild, 'only the target subtree was rebuilt');
    assert.equal(view.element.children[0].textContent, 'b');
    assert.equal(view.describe().children[0].props.label, 'b');
});

test('a subtree rebuild leaves sibling state untouched', () => {
    const view = createView(owner, {
        id: 'v-focus',
        root: {
            component: 'column',
            children: [
                { component: 'input', props: { value: 'abcdef' } },
                { component: 'plainbox', props: { label: 'a' } },
            ],
        },
    });

    const input = view.element.children[0];
    input.focus();
    input.setSelectionRange(2, 5);

    // plainbox has no update: only its own element is replaced.
    view.setProps([1], { label: 'b' });

    assert.equal(view.element.children[0], input, 'the sibling input was not rebuilt');
    assert.equal(globalThis.document.activeElement, input, 'focus stayed in the untouched sibling');
    assert.equal(input.selectionStart, 2);
    assert.equal(view.element.children[1].textContent, 'b');
});

test('setRoot preserves focus, selection and scroll offsets across the rebuild', () => {
    const view = createView(owner, {
        id: 'v-focus-root',
        root: {
            component: 'column',
            children: [
                { component: 'input', props: { value: 'abcdef' } },
                { component: 'plainbox', props: { label: 'a' } },
            ],
        },
    });

    const input = view.element.children[0];
    input.focus();
    input.setSelectionRange(2, 5);
    view.element.scrollTop = 42;
    dom.fixture.window.scrollX = 7;
    dom.fixture.window.scrollY = 180;

    view.setRoot({
        component: 'column',
        children: [
            { component: 'input', props: { value: 'abcdef' } },
            { component: 'plainbox', props: { label: 'a' } },
        ],
    });

    const rebuilt = view.element;
    const rebuiltInput = rebuilt.children[0];
    assert.notEqual(rebuiltInput, input, 'the input element was rebuilt');
    assert.equal(globalThis.document.activeElement, rebuiltInput, 'focus followed the equivalent node');
    assert.equal(rebuiltInput.selectionStart, 2);
    assert.equal(rebuiltInput.selectionEnd, 5);
    assert.equal(rebuilt.scrollTop, 42, 'the scroll offset of the rebuilt root was restored');
    assert.equal(dom.fixture.window.scrollX, 7, 'page scroll was not thrown away');
    assert.equal(dom.fixture.window.scrollY, 180, 'page scroll was not thrown away');
});

test('serializeView drops handlers and round-trips through JSON', () => {
    let clicks = 0;
    const view = createView(owner, {
        id: 'v-source',
        root: {
            component: 'card',
            props: { title: 'Panel' },
            children: [
                'shorthand child',
                {
                    component: 'row',
                    props: { gap: 4 },
                    children: [{ component: 'counter', props: { value: 3, label: 'n' } }],
                },
                {
                    component: 'button',
                    props: { label: 'Go' },
                    on: { click: () => { clicks += 1; } },
                },
            ],
        },
    });

    const serialized = serializeView('v-source');
    assert.deepEqual(serialized, view.describe(), 'serialization matches describe() structure');
    assert.deepEqual(serialized, view.serialize(), 'the view handle exposes the same data');
    assert.equal(JSON.stringify(serialized).includes('"on"'), false, 'handlers are dropped');
    assert.deepEqual(JSON.parse(JSON.stringify(serialized)), serialized, 'output is JSON-safe');
    assert.equal(serialized.children[0].component, 'text', 'string shorthand becomes a text node');

    // Mutating the serialized copy must not mutate the mounted tree.
    serialized.children[0].props.text = 'changed';
    assert.equal(view.describe().children[0].props.text, 'shorthand child');

    const raw = JSON.parse(JSON.stringify(serializeView('v-source')));
    const copy = createViewFromSerialized(owner, raw, { id: 'v-copy' });
    assert.deepEqual(copy.describe(), view.describe(), 'the remounted view is structurally equivalent');
    assert.equal(copy.element.dataset.loomComponent, 'card');

    // The copy has no handlers: clicking it is a no-op instead of calling the original.
    copy.element.querySelector('.loom-button').dispatchEvent(createEvent('click'));
    assert.equal(clicks, 0);
    view.element.querySelector('.loom-button').dispatchEvent(createEvent('click'));
    assert.equal(clicks, 1, 'the original view kept its handler');
});

test('createViewFromSerialized rejects handler payloads and unknown views', () => {
    assert.throws(
        () => createViewFromSerialized(owner, { component: 'button', props: { label: 'x' }, on: { click: () => {} } }),
        /cannot contain event handlers/,
    );
    assert.throws(
        () => createViewFromSerialized(owner, {
            component: 'row',
            children: [{ component: 'button', props: { label: 'x' }, on: {} }],
        }),
        /cannot contain event handlers/,
    );
    assert.throws(() => createViewFromSerialized(owner, 42), /must be a string or an object/);
    assert.throws(() => serializeView('missing-view'), /View not found: missing-view/);
});

test('describe() and listViews() keep their existing shape', () => {
    const view = createView(owner, { id: 'v-shape', root: 'hello' });

    assert.deepEqual(view.describe(), {
        component: 'text',
        props: { text: 'hello', variant: 'body', tone: 'default' },
        children: [],
    });
    assert.deepEqual(listViews(owner), [{
        id: 'v-shape',
        extensionId: owner,
        root: view.describe(),
    }]);
});

test('runs component cleanups and unmount hooks when the view is destroyed', () => {
    const view = createView(owner, {
        id: 'v-lifecycle',
        root: { component: 'lifecycle', props: { label: 'root' }, children: ['child text'] },
    });
    assert.deepEqual(lifecycleLog, []);

    view.destroy();
    assert.deepEqual(lifecycleLog, ['cleanup2:root', 'cleanup:root', 'unmount:root'], 'cleanups run LIFO before unmount');
    assert.equal(view.destroy(), false, 'destroy is idempotent');
    assert.equal(lifecycleLog.length, 3, 'cleanups must not run twice');
});

test('disposes children before parents when the root is replaced', () => {
    const view = createView(owner, {
        id: 'v-nested',
        root: {
            component: 'lifecycle',
            props: { label: 'parent' },
            children: [{ component: 'lifecycle', props: { label: 'child' } }],
        },
    });

    view.setRoot({ component: 'lifecycle', props: { label: 'next' } });
    assert.deepEqual(lifecycleLog, [
        'cleanup2:child', 'cleanup:child', 'unmount:child',
        'cleanup2:parent', 'cleanup:parent', 'unmount:parent',
    ], 'leaves are released before the parent that contains them');
});

test('a throwing cleanup does not stop the others or the unmount hook', () => {
    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(' '));
    try {
        registerComponent(owner, {
            id: 'throws-on-cleanup',
            name: 'Throws',
            props: {},
            mount: (props, context) => {
                context.onCleanup(() => { throw new Error('cleanup boom'); });
                context.onCleanup(() => { lifecycleLog.push('after-throw'); });
                return document.createElement('div');
            },
            unmount: () => { lifecycleLog.push('unmounted'); },
        });

        const view = createView(owner, { id: 'v-throw', root: { component: 'throws-on-cleanup', props: {} } });
        view.destroy();
        assert.deepEqual(lifecycleLog, ['after-throw', 'unmounted']);
        assert.equal(errors.some(message => message.includes('cleanup boom')), true, 'the failure is reported');
    } finally {
        console.error = originalError;
    }
});

test('in-place prop updates do not trigger cleanups', () => {
    const view = createView(owner, {
        id: 'v-inplace-lifecycle',
        root: { component: 'lifecycle', props: { label: 'kept' } },
    });
    view.setProps([], { label: 'kept' });
    assert.deepEqual(lifecycleLog, [], 'update must not dispose the component');
});

test('rejects a non-function cleanup registration', () => {
    registerComponent(owner, {
        id: 'bad-cleanup',
        name: 'Bad cleanup',
        props: {},
        mount: (props, context) => {
            context.onCleanup('not a function');
            return document.createElement('div');
        },
    });

    assert.throws(
        () => createView(owner, { id: 'v-bad-cleanup', root: { component: 'bad-cleanup', props: {} } }),
        /onCleanup expects a function/,
    );
});

test('onMount callbacks run once, after the tree is attached', () => {
    const calls = [];
    registerComponent(owner, {
        id: 'mount-probe',
        name: 'Mount probe',
        container: true,
        props: { label: { type: 'string', default: '' } },
        mount: (props, context) => {
            const element = document.createElement('div');
            element.className = 'mount-probe';
            context.onMount(attached => {
                calls.push(`${props.label}:${document.body.contains(attached)}`);
            });
            return element;
        },
        update: (element, props) => { element.textContent = props.label; },
    });

    const view = createView(owner, {
        id: 'v-mount-probe',
        root: {
            component: 'mount-probe',
            props: { label: 'root' },
            children: [{ component: 'mount-probe', props: { label: 'child' } }],
        },
    });

    assert.deepEqual(calls, ['root:true', 'child:true'], 'callbacks run parent-first with a connected element');

    // In-place updates do not re-run the mount callback.
    view.setProps([], { label: 'root' });
    assert.equal(calls.length, 2);

    // A structural rebuild produces a fresh mount, so the callback runs again.
    view.setRoot({ component: 'mount-probe', props: { label: 'fresh' } });
    assert.deepEqual(calls.slice(2), ['fresh:true']);
});

test('a throwing onMount callback does not break the view', () => {
    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(' '));
    try {
        registerComponent(owner, {
            id: 'mount-throws',
            name: 'Mount throws',
            props: {},
            mount: (props, context) => {
                context.onMount(() => { throw new Error('mount boom'); });
                return document.createElement('div');
            },
        });
        const view = createView(owner, { id: 'v-mount-throws', root: { component: 'mount-throws', props: {} } });
        assert.ok(view.element);
        assert.equal(errors.some(message => message.includes('mount boom')), true, 'the failure is reported');
    } finally {
        console.error = originalError;
    }
});

test('rejects a non-function mount callback registration', () => {
    registerComponent(owner, {
        id: 'bad-mount-callback',
        name: 'Bad mount callback',
        props: {},
        mount: (props, context) => {
            context.onMount(42);
            return document.createElement('div');
        },
    });

    assert.throws(
        () => createView(owner, { id: 'v-bad-mount', root: { component: 'bad-mount-callback', props: {} } }),
        /onMount expects a function/,
    );
});

/* ------------------------------------------------------------------------- */
/* keyed reconciliation                                                       */
/* ------------------------------------------------------------------------- */

function keyedList(items) {
    return {
        component: 'column',
        children: items.map(item => ({
            component: 'lifecycle',
            key: item.id,
            props: { label: item.label },
        })),
    };
}

test('keyed children keep their element and state when reordered', () => {
    const view = createView(owner, { id: 'v-keyed', root: keyedList([
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
    ]) });

    const [a, b, c] = [...view.element.children];
    lifecycleLog = [];

    view.setChildren([], keyedList([
        { id: 'c', label: 'C' },
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
    ]).children);

    const reordered = [...view.element.children];
    assert.equal(reordered[0], c, 'C kept its element');
    assert.equal(reordered[1], a, 'A kept its element');
    assert.equal(reordered[2], b, 'B kept its element');
    assert.deepEqual(lifecycleLog, [], 'a reorder must not dispose or remount anything');
    assert.deepEqual(view.describe().children.map(child => child.key), ['c', 'a', 'b']);
});

test('keyed children are inserted and removed individually', () => {
    const view = createView(owner, { id: 'v-keyed-io', root: keyedList([
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
    ]) });

    const [a, b] = [...view.element.children];
    lifecycleLog = [];

    view.setChildren([], keyedList([
        { id: 'a', label: 'A' },
        { id: 'x', label: 'X' },
        { id: 'b', label: 'B' },
    ]).children);

    const afterInsert = [...view.element.children];
    assert.equal(afterInsert[0], a, 'A was reused');
    assert.equal(afterInsert[2], b, 'B was reused');
    assert.equal(afterInsert[1].textContent, 'X');
    assert.deepEqual(lifecycleLog, [], 'inserting must not touch the existing items');

    lifecycleLog = [];
    view.setChildren([], keyedList([{ id: 'a', label: 'A' }]).children);
    assert.deepEqual([...view.element.children], [a]);
    assert.deepEqual(lifecycleLog, [
        'cleanup2:X', 'cleanup:X', 'unmount:X',
        'cleanup2:B', 'cleanup:B', 'unmount:B',
    ], 'only the removed items are disposed, in document order');
});

test('a keyed item updates in place when only its props change', () => {
    const view = createView(owner, { id: 'v-keyed-props', root: keyedList([{ id: 'a', label: 'A' }]) });
    const [a] = [...view.element.children];
    lifecycleLog = [];

    view.setChildren([], keyedList([{ id: 'a', label: 'A2' }]).children);
    assert.equal(view.element.children[0], a, 'the element was reused');
    assert.equal(a.textContent, 'A2');
    assert.deepEqual(lifecycleLog, [], 'an in-place item update does not remount');
});

test('unkeyed children fall back to index + component matching', () => {
    const view = createView(owner, {
        id: 'v-unkeyed',
        root: {
            component: 'column',
            children: [
                { component: 'lifecycle', props: { label: 'first' } },
                { component: 'lifecycle', props: { label: 'second' } },
            ],
        },
    });

    const [first, second] = [...view.element.children];
    lifecycleLog = [];

    view.setChildren([], [
        { component: 'lifecycle', props: { label: 'first' } },
        { component: 'lifecycle', props: { label: 'second' } },
    ]);
    assert.deepEqual([...view.element.children], [first, second], 'same shape reuses both elements');
    assert.deepEqual(lifecycleLog, []);
});

test('a changed component at the same index is remounted, not patched', () => {
    const view = createView(owner, {
        id: 'v-component-swap',
        root: { component: 'column', children: [{ component: 'lifecycle', props: { label: 'a' } }] },
    });

    const previous = view.element.children[0];
    lifecycleLog = [];

    view.setChildren([], [{ component: 'plainbox', props: { label: 'swapped' } }]);
    const next = view.element.children[0];
    assert.notEqual(next, previous);
    assert.equal(next.textContent, 'swapped');
    assert.deepEqual(lifecycleLog, ['cleanup2:a', 'cleanup:a', 'unmount:a'], 'the replaced item was disposed');
});

test('appendChild and remove update only the affected child', () => {
    const view = createView(owner, {
        id: 'v-append-remove',
        root: { component: 'column', children: [{ component: 'lifecycle', props: { label: 'kept' } }] },
    });

    const kept = view.element.children[0];
    view.appendChild([], { component: 'lifecycle', props: { label: 'added' } });
    assert.equal(view.element.children[0], kept, 'the existing child was not rebuilt');
    assert.equal(view.element.children[1].textContent, 'added');

    lifecycleLog = [];
    view.remove([1]);
    assert.deepEqual([...view.element.children], [kept]);
    assert.deepEqual(lifecycleLog, ['cleanup2:added', 'cleanup:added', 'unmount:added']);
    assert.deepEqual(view.describe().children.map(child => child.props.label), ['kept']);
});

test('rejects duplicate sibling keys', () => {
    assert.throws(() => createView(owner, {
        id: 'v-duplicate-keys',
        root: {
            component: 'column',
            children: [
                { component: 'lifecycle', key: 'dup', props: { label: 'one' } },
                { component: 'lifecycle', key: 'dup', props: { label: 'two' } },
            ],
        },
    }), /Duplicate node key/);

    assert.throws(() => createView(owner, {
        id: 'v-bad-key',
        root: { component: 'lifecycle', key: true, props: {} },
    }), /key must be a non-empty string or a finite number/);
});

test('keyed children survive serialization round-trips', () => {
    const view = createView(owner, { id: 'v-keyed-serialize', root: keyedList([{ id: 'a', label: 'A' }]) });
    const serialized = view.serialize();
    assert.equal(serialized.children[0].key, 'a');
    assert.equal(JSON.stringify(JSON.parse(JSON.stringify(serialized))).includes('"key":"a"'), true);
});

test('a reconciled child rebinds changed event handlers', () => {
    const clicked = [];
    const view = createView(owner, {
        id: 'v-rebind',
        root: {
            component: 'column',
            children: [{
                component: 'button',
                key: 'btn',
                props: { label: 'Go' },
                on: { click: () => clicked.push('first') },
            }],
        },
    });

    view.setChildren([], [{
        component: 'button',
        key: 'btn',
        props: { label: 'Go' },
        on: { click: () => clicked.push('second') },
    }]);

    view.element.children[0].dispatchEvent(createEvent('click'));
    assert.deepEqual(clicked, ['second'], 'the reconciled handler replaced the old one');
});
