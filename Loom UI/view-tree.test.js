import test from 'node:test';
import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
import { registerExtension, unregisterExtension } from '../Loom%20Core/index.js';
import { registerComponent, resetComponents } from './components.js';
import { BUILTIN_COMPONENTS } from './builtin-components.js';
import {
    appendNodeChild,
    describeNode,
    emitNodeEvent,
    locateNode,
    normalizeNode,
    removeNodeAt,
    updateNodeChildren,
    updateNodeProps,
    validateNode,
} from './view-tree.js';

const owner = 'view-tree-owner';

function ensureOwner() {
    if (!globalThis.Loom.listExtensions().some(extension => extension.id === owner)) {
        registerExtension({ id: owner, name: 'View Tree Owner' });
    }
}

function registerDemoComponents() {
    ensureOwner();
    const text = BUILTIN_COMPONENTS.find(component => component.id === 'text');
    registerComponent(owner, text);
    registerComponent(owner, {
        id: 'demo-text', name: 'Text', props: { text: { type: 'string', required: true }, tone: { type: 'string', default: 'default' } },
        mount: () => ({}),
    });
    registerComponent(owner, {
        id: 'demo-box', name: 'Box', container: true, props: {}, mount: () => ({}),
    });
    registerComponent(owner, {
        id: 'demo-button', name: 'Button', props: { label: { type: 'string', required: true } }, events: ['click'], mount: () => ({}),
    });
}

afterEach(() => {
    unregisterExtension(owner);
    resetComponents();
});

test('normalizes shorthand nodes and validates structure', () => {
    registerDemoComponents();
    assert.deepEqual(normalizeNode('hello'), { component: 'text', props: { text: 'hello' }, children: [], on: {} });

    const tree = validateNode({
        component: 'demo-box',
        children: [
            'plain string child',
            { component: 'demo-text', props: { text: 'second' } },
        ],
    });
    assert.equal(tree.component, 'demo-box');
    assert.equal(tree.children.length, 2);
    assert.equal(tree.children[0].props.text, 'plain string child');
    assert.equal(tree.children[1].props.tone, 'default');

    assert.throws(() => validateNode(42), /must be a string or/);
    assert.throws(() => validateNode({}), /requires a component id/);
    assert.throws(() => validateNode({ component: 'nope' }), /Unknown component/);
    assert.throws(() => validateNode({ component: 'demo-text', props: { text: 'x' }, children: ['child'] }), /not a container/);
    assert.throws(() => validateNode({ component: 'demo-text', props: { text: 'x' }, children: 'bad' }), /children must be an array/);
});

test('validates declared events on nodes', () => {
    registerDemoComponents();
    assert.throws(() => validateNode({ component: 'demo-text', props: { text: 'x' }, on: { click: () => {} } }), /does not emit event/);
    assert.throws(() => validateNode({ component: 'demo-button', props: { label: 'x' }, on: { click: 'nope' } }), /handler must be a function/);

    const tree = validateNode({ component: 'demo-button', props: { label: 'x' }, on: { click: () => {} } });
    assert.equal(typeof tree.on.click, 'function');
});

test('describes a tree without functions', () => {
    registerDemoComponents();
    const tree = validateNode({
        component: 'demo-box',
        children: [{ component: 'demo-button', props: { label: 'Go' }, on: { click: () => {} } }],
    });
    const described = describeNode(tree);
    assert.deepEqual(described, {
        component: 'demo-box',
        props: {},
        children: [{ component: 'demo-button', props: { label: 'Go' }, children: [] }],
    });
    assert.equal(JSON.stringify(described).includes('function'), false);
});

test('locates and mutates nodes by path', () => {
    registerDemoComponents();
    const tree = validateNode({
        component: 'demo-box',
        children: [
            { component: 'demo-text', props: { text: 'first' } },
            { component: 'demo-box', children: [{ component: 'demo-text', props: { text: 'nested' } }] },
        ],
    });

    assert.equal(locateNode(tree, [1, 0]).props.text, 'nested');
    assert.throws(() => locateNode(tree, [5]), /path not found/);
    assert.throws(() => locateNode(tree, ['x']), /non-negative integers/);

    updateNodeProps(tree, [0], { text: 'updated', tone: 'info' });
    assert.deepEqual(locateNode(tree, [0]).props, { text: 'updated', tone: 'info' });

    appendNodeChild(tree, [1], { component: 'demo-text', props: { text: 'appended' } });
    assert.equal(locateNode(tree, [1, 1]).props.text, 'appended');

    updateNodeChildren(tree, [1], ['replaced']);
    assert.equal(tree.children[1].children.length, 1);
    assert.equal(locateNode(tree, [1, 0]).props.text, 'replaced');

    const removed = removeNodeAt(tree, [1]);
    assert.equal(removed.component, 'demo-box');
    assert.equal(tree.children.length, 1);
    assert.throws(() => removeNodeAt(tree, []), /Cannot remove the root node/);
    assert.throws(() => updateNodeChildren(tree, [0], ['child']), /not a container/);
});

test('emits node events with context and isolates handler failures', async () => {
    registerDemoComponents();
    const definition = { id: 'demo-button' };
    const seen = [];
    const okHandler = event => seen.push(event);
    emitNodeEvent(definition, { click: okHandler }, { extensionId: owner, viewId: 'view-1' }, [0], 'click', { value: 1 });
    assert.deepEqual(seen, [{ event: 'click', payload: { value: 1 }, path: [0], viewId: 'view-1', extensionId: owner }]);

    const originalError = console.error;
    let logged = 0;
    console.error = () => { logged += 1; };
    try {
        emitNodeEvent(definition, { click: () => { throw new Error('boom'); } }, { extensionId: owner, viewId: 'v' }, [], 'click', null);
        emitNodeEvent(definition, { click: async () => { throw new Error('async boom'); } }, { extensionId: owner, viewId: 'v' }, [], 'click', null);
        await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
        console.error = originalError;
    }
    assert.equal(logged >= 2, true);
    // A missing handler is a no-op.
    emitNodeEvent(definition, {}, { extensionId: owner, viewId: 'v' }, [], 'click', null);
});
