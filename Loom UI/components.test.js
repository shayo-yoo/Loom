import test from 'node:test';
import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
import { registerExtension, unregisterExtension } from '../Loom%20Core/index.js';
import {
    getComponent,
    listComponents,
    registerComponent,
    resetComponents,
    resolveProps,
    unregisterComponent,
} from './components.js';
import { BUILTIN_COMPONENTS } from './builtin-components.js';

const owner = 'ui-test-owner';

function ensureOwner() {
    if (!globalThis.Loom.listExtensions().some(extension => extension.id === owner)) {
        registerExtension({ id: owner, name: 'UI Test Owner' });
    }
}

afterEach(() => {
    unregisterExtension(owner);
    resetComponents();
});

const textComponent = {
    id: 'demo-text',
    name: 'Demo Text',
    description: 'A demo component.',
    props: {
        text: { type: 'string', required: true },
        tone: { type: 'string', default: 'default' },
        count: { type: 'number', default: 1 },
    },
    events: ['change'],
    mount: () => ({ tagName: 'DIV' }),
};

test('registers a component and exposes a descriptor copy', () => {
    ensureOwner();
    const descriptor = registerComponent(owner, textComponent);
    assert.equal(descriptor.id, 'demo-text');
    assert.equal(descriptor.extensionId, owner);
    assert.deepEqual(descriptor.events, ['change']);
    assert.equal(descriptor.container, false);
    assert.deepEqual(descriptor.props.map(prop => prop.name), ['text', 'tone', 'count']);

    descriptor.props[0].name = 'tampered';
    assert.equal(getComponent('demo-text').props[0].name, 'text');
    assert.equal(listComponents(owner).length, 1);
});

test('built-in grid exposes an opt-out responsive layout prop', () => {
    const grid = BUILTIN_COMPONENTS.find(component => component.id === 'grid');
    const responsive = grid.props.responsive;
    assert.equal(responsive.type, 'boolean');
    assert.equal(responsive.default, true);
    assert.equal(grid.container, true);
});

test('rejects invalid component definitions and duplicate ids', () => {
    ensureOwner();
    assert.throws(() => registerComponent(owner, { id: 'no-mount', name: 'No mount' }), /mount must be a function/);
    assert.throws(() => registerComponent(owner, { id: 'no name', name: 'x', mount: () => ({}) }), /Component id/);
    assert.throws(() => registerComponent(owner, { id: 'bad-name', name: '', mount: () => ({}) }), /name is required/);
    assert.throws(() => registerComponent(owner, {
        id: 'bad-prop', name: 'Bad prop', props: { value: 'function' }, mount: () => ({}),
    }), /unsupported type/);

    registerComponent(owner, textComponent);
    assert.throws(() => registerComponent(owner, textComponent), /already registered/);
    assert.throws(() => registerComponent('not-registered', textComponent), /Register the extension/);
});

test('resolves props with defaults, required checks and type checks', () => {
    ensureOwner();
    const component = registerComponent(owner, textComponent);
    assert.deepEqual(resolveProps(component, { text: 'hello' }), { text: 'hello', tone: 'default', count: 1 });
    assert.deepEqual(resolveProps(component, { text: 'hi', tone: 'error', count: 3 }), { text: 'hi', tone: 'error', count: 3 });

    assert.throws(() => resolveProps(component, {}), /"text" is required/);
    assert.throws(() => resolveProps(component, { text: 5 }), /expects string, received number/);
    assert.throws(() => resolveProps(component, { text: 'x', count: 'three' }), /expects number, received string/);
    assert.throws(() => resolveProps(component, { text: 'x', extra: true }), /does not accept prop "extra"/);
    assert.throws(() => resolveProps(component, null), /props must be an object/);
});

test('unregistering the owning extension removes its components', () => {
    ensureOwner();
    registerComponent(owner, textComponent);
    assert.equal(listComponents(owner).length, 1);
    unregisterExtension(owner);
    assert.equal(getComponent('demo-text'), null);
    assert.equal(listComponents().length, 0);
});

test('components can be removed explicitly', () => {
    ensureOwner();
    registerComponent(owner, textComponent);
    assert.equal(unregisterComponent('demo-text'), true);
    assert.equal(unregisterComponent('demo-text'), false);
    assert.equal(listComponents(owner).length, 0);
});
