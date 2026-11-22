import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { formatBlock } from '../Loom%20Core/markers.js';
import { registerExtension, unregisterExtension } from '../Loom%20Core/index.js';
import { registerComponent, resetComponents } from './components.js';
import { BUILTIN_COMPONENTS } from './builtin-components.js';
import {
    disposeMessageBlocks,
    getBlock,
    listBlockMounts,
    listBlocks,
    refreshBlocks,
    registerBlock,
    renderBlocksIn,
    resetBlockMounts,
    unregisterBlocks,
} from './blocks.js';
import { resetViews } from './views.js';
import { installDomFixture } from './dom-fixture.js';

const owner = 'block-test-owner';
let dom;

/** A message body the way SillyTavern renders one: `.mes[mesid] > .mes_text`. */
function addMessage(messageId, text) {
    const chat = document.querySelector('#chat') ?? (() => {
        const element = document.createElement('div');
        element.id = 'chat';
        document.body.append(element);
        return element;
    })();
    const mes = document.createElement('div');
    mes.className = 'mes';
    mes.setAttribute('mesid', String(messageId));
    const body = document.createElement('div');
    body.className = 'mes_text';
    body.textContent = text;
    mes.append(body);
    chat.append(mes);
    return { mes, body };
}

beforeEach(() => {
    dom = installDomFixture();
    registerExtension({ id: owner, name: 'Block Test Owner' });
    for (const component of BUILTIN_COMPONENTS) registerComponent(owner, component);
});

afterEach(() => {
    resetBlockMounts();
    resetViews();
    unregisterExtension(owner);
    resetComponents();
    dom.uninstall();
});

test('renders a registered block in place of its marker text', () => {
    registerBlock(owner, {
        id: 'hud',
        name: 'HUD',
        build: ({ inner }) => ({ component: 'text', props: { text: `hp=${inner}` } }),
    });

    const { body } = addMessage(0, `before ${formatBlock('hud', '5')} after`);
    const count = renderBlocksIn(body, { messageId: 0, message: { index: 0 } });

    assert.equal(count, 1);
    assert.equal(body.textContent.includes('\u27E6loom:'), false, 'the marker text is gone');
    assert.match(body.textContent, /before/);
    assert.match(body.textContent, /after/);
    const host = body.querySelector('.loom-block');
    assert.equal(host.dataset.loomBlock, 'hud');
    assert.equal(host.dataset.loomMesid, '0');
    assert.match(host.textContent, /hp=5/);
    assert.deepEqual(listBlockMounts(0), [{ kind: 'hud', extensionId: owner }]);
});

test('an unregistered kind is hidden instead of showing raw syntax', () => {
    const { body } = addMessage(1, `text ${formatBlock('missing')} tail`);
    renderBlocksIn(body, { messageId: 1 });

    assert.equal(body.textContent.includes('\u27E6loom:'), false);
    const host = body.querySelector('.loom-block');
    assert.equal(host.hidden, true, 'nothing is drawn, but the marker is not visible');
    assert.equal(host.dataset.loomUnrendered, 'true');
    assert.deepEqual(listBlockMounts(1), [], 'no view is mounted for an unknown kind');
});

test('a throwing builder leaves a hidden placeholder instead of breaking the message', () => {
    registerBlock(owner, {
        id: 'broken',
        build: () => { throw new Error('builder exploded'); },
    });
    const { body } = addMessage(2, `a ${formatBlock('broken')} b`);
    renderBlocksIn(body, { messageId: 2 });

    const host = body.querySelector('.loom-block');
    assert.equal(host.hidden, true);
    assert.match(host.dataset.loomError, /builder exploded/);
    assert.equal(body.textContent.includes('\u27E6loom:'), false, 'the marker never survives');
});

test('re-rendering a message replaces its mounts instead of duplicating them', () => {
    registerBlock(owner, {
        id: 'hud',
        build: ({ inner }) => ({ component: 'text', props: { text: inner } }),
    });
    const { body } = addMessage(3, `x ${formatBlock('hud', 'first')} y`);
    renderBlocksIn(body, { messageId: 3 });
    assert.equal(listBlockMounts(3).length, 1);

    // SillyTavern rebuilds the body from the stored text on edit/swipe.
    body.textContent = `x ${formatBlock('hud', 'second')} y`;
    renderBlocksIn(body, { messageId: 3 });

    assert.equal(listBlockMounts(3).length, 1, 'one mount per message, not two');
    assert.equal(body.querySelectorAll('.loom-block').length, 1);
    assert.match(body.querySelector('.loom-block').textContent, /second/);
});

test('several blocks in one message are all rendered, across text nodes', () => {
    registerBlock(owner, { id: 'hud', build: ({ inner }) => ({ component: 'text', props: { text: inner } }) });
    const { body } = addMessage(4, '');
    body.textContent = `a ${formatBlock('hud', '1')} b ${formatBlock('hud', '2')} c`;
    renderBlocksIn(body, { messageId: 4 });

    const hosts = [...body.querySelectorAll('.loom-block')];
    assert.equal(hosts.length, 2);
    assert.deepEqual(hosts.map(host => host.textContent), ['1', '2']);
    assert.equal(body.textContent, 'a 1 b 2 c', 'surrounding text and widgets stay in order');
});

test('refreshBlocks only touches messages that contain a block', () => {
    registerBlock(owner, { id: 'hud', build: () => ({ component: 'text', props: { text: 'hud' } }) });
    addMessage(0, 'plain message');
    addMessage(1, `with ${formatBlock('hud', '')}`);

    const rendered = refreshBlocks();
    assert.equal(rendered, 1);
    assert.equal(listBlockMounts(0).length, 0, 'a message without blocks costs nothing');
    assert.equal(listBlockMounts(1).length, 1);
});

test('a message that loses its block drops its stale mounts', () => {
    registerBlock(owner, { id: 'hud', build: () => ({ component: 'text', props: { text: 'hud' } }) });
    const { body } = addMessage(5, `${formatBlock('hud')}`);
    refreshBlocks();
    assert.equal(listBlockMounts(5).length, 1);

    body.textContent = 'edited, block removed';
    refreshBlocks();
    assert.deepEqual(listBlockMounts(5), []);
});

test('unregistering the owning extension removes its blocks and mounts', () => {
    registerBlock(owner, { id: 'hud', build: () => ({ component: 'text', props: { text: 'hud' } }) });
    const { body } = addMessage(6, `${formatBlock('hud')}`);
    renderBlocksIn(body, { messageId: 6 });
    assert.equal(listBlocks(owner).length, 1);

    unregisterExtension(owner);
    assert.deepEqual(listBlocks(owner), []);
    assert.deepEqual(listBlockMounts(6), []);
    assert.equal(document.querySelectorAll('.loom-block').length, 0, 'no widget survives its owner');

    registerExtension({ id: owner, name: 'Block Test Owner' });
});

test('registration is validated and ids cannot be reused', () => {
    assert.throws(() => registerBlock(owner, null), /must be an object/);
    assert.throws(() => registerBlock(owner, { id: 'bad id', build: () => 'x' }), /must be an identifier/);
    assert.throws(() => registerBlock(owner, { id: 'nobuild' }), /build must be a function/);

    registerBlock(owner, { id: 'dup', build: () => ({ component: 'text', props: { text: 'x' } }) });
    assert.equal(getBlock('dup')?.extensionId, owner);
    assert.throws(() => registerBlock(owner, { id: 'dup', build: () => 'x' }), /already registered/);

    unregisterBlocks(owner);
    assert.equal(getBlock('dup'), null);
});

test('disposeMessageBlocks is idempotent', () => {
    registerBlock(owner, { id: 'hud', build: () => ({ component: 'text', props: { text: 'hud' } }) });
    const { body } = addMessage(7, `${formatBlock('hud')}`);
    renderBlocksIn(body, { messageId: 7 });

    assert.equal(disposeMessageBlocks(7), 1);
    assert.equal(disposeMessageBlocks(7), 0);
});
