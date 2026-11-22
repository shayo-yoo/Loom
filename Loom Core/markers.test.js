import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BLOCK_ID_PATTERN,
    formatBlock,
    hasBlocks,
    parseBlocks,
    stripBlocks,
    stripBlocksFromMessage,
} from './markers.js';

const OPEN = '\u27E6';
const CLOSE = '\u27E7';

test('formats pointers and paired blocks', () => {
    assert.equal(formatBlock('hud'), `${OPEN}loom:hud${CLOSE}`);
    assert.equal(formatBlock('widget', '{"a":1}'), `${OPEN}loom:widget${CLOSE}{"a":1}${OPEN}/loom${CLOSE}`);
    assert.throws(() => formatBlock('bad kind'), /must be an identifier/);
    assert.throws(() => formatBlock(''), /must be an identifier/);
});

test('parses paired blocks, pointers and multiple blocks', () => {
    const text = `before ${OPEN}loom:widget${CLOSE}payload${OPEN}/loom${CLOSE} middle ${OPEN}loom:hud${CLOSE} after`;
    const blocks = parseBlocks(text);
    assert.deepEqual(blocks.map(block => [block.kind, block.inner, block.pointer]), [
        ['widget', 'payload', false],
        ['hud', '', true],
    ]);
    assert.equal(text.slice(blocks[0].from, blocks[0].to), `${OPEN}loom:widget${CLOSE}payload${OPEN}/loom${CLOSE}`);
});

test('is case-insensitive about the marker and normalises the kind', () => {
    const blocks = parseBlocks(`${OPEN}LOOM:HUD${CLOSE}${OPEN}/LoOm${CLOSE}`);
    assert.deepEqual(blocks.map(block => block.kind), ['hud']);
});

test('an unclosed opening tag is reported as a pointer so its marker still leaks nothing', () => {
    const blocks = parseBlocks(`x ${OPEN}loom:hud${CLOSE} y`);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].pointer, true);
    assert.equal(stripBlocks(`x ${OPEN}loom:hud${CLOSE} y`), 'x  y');
});

test('a nested opening tag keeps both blocks removable', () => {
    const text = `${OPEN}loom:a${CLOSE}one ${OPEN}loom:b${CLOSE}two${OPEN}/loom${CLOSE} three`;
    const blocks = parseBlocks(text);
    assert.deepEqual(blocks.map(block => [block.kind, block.pointer]), [['a', true], ['b', false]]);
    assert.equal(stripBlocks(text).includes('loom:'), false, 'no marker survives');
});

test('stripBlocks removes blocks and keeps the surrounding text', () => {
    assert.equal(stripBlocks(`a${OPEN}loom:hud${CLOSE}${OPEN}/loom${CLOSE}b`), 'ab');
    assert.equal(stripBlocks('no blocks here'), 'no blocks here');
    assert.equal(stripBlocks(''), '');
    assert.equal(stripBlocks(null), '', 'a non-string yields an empty string, never a crash');
});

test('stripBlocks can keep a replacement so the model still sees a summary', () => {
    const text = `${OPEN}loom:hud${CLOSE}hp=5${OPEN}/loom${CLOSE}`;
    assert.equal(stripBlocks(text, { replacement: (kind, inner) => `[${kind}:${inner}]` }), '[hud:hp=5]');
    assert.equal(stripBlocks(text, { replacement: () => null }), '', 'a non-string replacement inserts nothing');
});

test('stripBlocksFromMessage preserves the message shape', () => {
    const chatMessage = { role: 'assistant', content: `hi ${OPEN}loom:hud${CLOSE}` };
    assert.deepEqual(stripBlocksFromMessage(chatMessage), { role: 'assistant', content: 'hi ' });

    const unchanged = { role: 'user', content: 'plain' };
    assert.equal(stripBlocksFromMessage(unchanged), unchanged, 'an unaffected message keeps its identity');

    const storish = { mes: `x ${OPEN}loom:hud${CLOSE}`, is_user: false };
    assert.deepEqual(stripBlocksFromMessage(storish), { mes: 'x ', is_user: false });

    assert.equal(stripBlocksFromMessage('text'), 'text');
    assert.equal(stripBlocksFromMessage(null), null);
    assert.deepEqual(stripBlocksFromMessage({ image_url: 'x' }), { image_url: 'x' }, 'unknown shapes pass through');
});

test('hasBlocks is a cheap pre-check', () => {
    assert.equal(hasBlocks(`a${OPEN}loom:hud${CLOSE}`), true);
    assert.equal(hasBlocks('plain text'), false);
    assert.equal(hasBlocks(''), false);
    assert.equal(BLOCK_ID_PATTERN.test('hud.widget-2'), true);
});
