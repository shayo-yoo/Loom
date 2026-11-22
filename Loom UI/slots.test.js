import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerExtension, unregisterExtension } from '../Loom%20Core/index.js';
import { registerComponent, resetComponents } from './components.js';
import { BUILTIN_COMPONENTS } from './builtin-components.js';
import { listSlotMounts, mountToSlot, resetSlotMounts, SLOTS, unmountFromSlot } from './slots.js';
import { resetViews } from './views.js';
import { installDomFixture } from './dom-fixture.js';

const owner = 'slot-test-owner';
let dom;

function addContainer(selector) {
    const id = selector.replace('#', '');
    const element = document.createElement('div');
    element.id = id;
    document.body.append(element);
    return element;
}

beforeEach(() => {
    dom = installDomFixture();
    registerExtension({ id: owner, name: 'Slot Test Owner' });
    for (const component of BUILTIN_COMPONENTS) registerComponent(owner, component);
});

afterEach(() => {
    resetSlotMounts();
    resetViews();
    unregisterExtension(owner);
    resetComponents();
    dom.uninstall();
});

test('mounts a view into an allowlisted host slot', () => {
    const settings = addContainer(SLOTS.settings);
    const view = mountToSlot(owner, 'settings', {
        root: { component: 'text', props: { text: 'inside settings' } },
    });

    assert.ok(view, 'the view mounts when the container exists');
    assert.equal(settings.querySelectorAll('.loom-slot').length, 1);
    assert.equal(settings.querySelector('.loom-slot').dataset.slot, 'settings');
    assert.match(settings.textContent, /inside settings/);
    assert.deepEqual(listSlotMounts(owner), [{ extensionId: owner, slot: 'settings', selector: SLOTS.settings }]);
});

test('mounting is lazy when the container is missing and replaces a previous mount', () => {
    assert.equal(mountToSlot(owner, 'menu', { root: { component: 'text', props: { text: 'late' } } }), null,
        'no container means no mount, not an error');
    assert.deepEqual(listSlotMounts(owner), []);

    const menu = addContainer(SLOTS.menu);
    mountToSlot(owner, 'menu', { root: { component: 'text', props: { text: 'first' } } });
    mountToSlot(owner, 'menu', { root: { component: 'text', props: { text: 'second' } } });
    assert.equal(menu.querySelectorAll('.loom-slot').length, 1, 're-mounting the same slot replaces it');
    assert.match(menu.textContent, /second/);
});

test('unmounting removes the wrapper, and an unknown slot is rejected', () => {
    const menu = addContainer(SLOTS.menu);
    mountToSlot(owner, 'menu', { root: { component: 'text', props: { text: 'bye' } } });
    assert.equal(unmountFromSlot(owner, 'menu'), true);
    assert.equal(menu.querySelectorAll('.loom-slot').length, 0);
    assert.equal(unmountFromSlot(owner, 'menu'), false, 'unmounting twice is a no-op');

    assert.throws(() => mountToSlot(owner, 'somewhere-else', { root: 'x' }), /Unknown UI slot/);
    assert.equal(document.querySelectorAll('.loom-slot').length, 0);
});

test('unregistering the extension removes its slot mounts', () => {
    const settings = addContainer(SLOTS.settings);
    mountToSlot(owner, 'settings', { root: { component: 'text', props: { text: 'orphan check' } } });
    assert.equal(settings.querySelectorAll('.loom-slot').length, 1);

    unregisterExtension(owner);
    assert.equal(settings.querySelectorAll('.loom-slot').length, 0,
        'unloading an extension cannot leave UI inside a host panel');
    assert.deepEqual(listSlotMounts(owner), []);
    // Re-register so afterEach can clean up without throwing.
    registerExtension({ id: owner, name: 'Slot Test Owner' });
});
