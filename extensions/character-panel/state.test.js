import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_STATE,
    applyCommand,
    applyReceipts,
    describeState,
    hasPanelMarker,
    normalizeState,
    panelLines,
    panelMarkerFor,
    parseReceipts,
} from './state.js';

test('the marker helpers use the framework grammar', () => {
    const marker = panelMarkerFor('character.panel');
    assert.equal(marker, '\u27E6loom:character.panel\u27E7\u27E6/loom\u27E7');
    assert.throws(() => panelMarkerFor('bad kind'), /must be an identifier/);

    assert.equal(hasPanelMarker([{ mes: `hi ${marker}` }], 'character.panel'), true);
    assert.equal(hasPanelMarker([{ mes: 'no marker' }], 'character.panel'), false);
    assert.equal(hasPanelMarker([], 'character.panel'), false);
    assert.equal(hasPanelMarker(null, 'character.panel'), false);
    // Another kind must not count: the check decides whether to write a new message.
    assert.equal(hasPanelMarker([{ mes: '\u27E6loom:other\u27E7\u27E6/loom\u27E7' }], 'character.panel'), false);
});

test('normalizeState coerces junk into a usable state', () => {
    assert.deepEqual(normalizeState(null), { level: 1, exp: 0, expNext: 100, gold: 10, items: {} });
    assert.deepEqual(normalizeState({ level: -3, exp: -5, expNext: 0, gold: -1, items: { a: 0, b: 2, c: -1 } }), {
        level: 1, exp: 0, expNext: 100, gold: 0, items: { b: 2 },
    });
    assert.deepEqual(normalizeState({ level: '4', exp: '20', expNext: '200', gold: '7' }).level, 4);
});

test('gold, exp and level commands change state and describe themselves', () => {
    const base = normalizeState(DEFAULT_STATE);

    const gold = applyCommand(base, { op: 'gold', delta: 5 });
    assert.equal(gold.state.gold, 15);
    assert.match(gold.note, /金币 \+5（现 15）/);

    const spend = applyCommand({ ...base, gold: 3 }, { op: 'gold', delta: -10 });
    assert.equal(spend.state.gold, 0, 'gold never goes negative');

    const exp = applyCommand(base, { op: 'exp', delta: 30 });
    assert.equal(exp.state.exp, 30);
    assert.equal(exp.state.level, 1);

    const level = applyCommand(base, { op: 'level', delta: 2 });
    assert.equal(level.state.level, 3);
});

test('experience crosses levels and raises the next threshold', () => {
    const result = applyCommand(normalizeState(DEFAULT_STATE), { op: 'exp', delta: 260 });
    assert.equal(result.state.level, 3, '100 then 150 exp thresholds are crossed');
    assert.equal(result.state.exp, 10);
    assert.equal(result.state.expNext, 225);
    assert.match(result.note, /升级 2 级/);
});

test('item commands add, consume and drop empty entries', () => {
    let state = normalizeState(DEFAULT_STATE);
    state = applyCommand(state, { op: 'item', name: '药水', delta: 2 }).state;
    assert.deepEqual(state.items, { 药水: 2 });

    state = applyCommand(state, { op: 'item', name: '药水', delta: -1 }).state;
    assert.deepEqual(state.items, { 药水: 1 });

    state = applyCommand(state, { op: 'item', name: '药水', delta: -5 }).state;
    assert.deepEqual(state.items, {}, 'consuming more than held removes the entry');
});

test('invalid commands are rejected rather than applied', () => {
    const base = normalizeState(DEFAULT_STATE);
    for (const command of [
        { op: 'gold', delta: 0 },
        { op: 'gold', delta: 'abc' },
        { op: 'luck', delta: 1 },
        { op: 'item', name: '', delta: 1 },
        { op: 'item', name: 'x'.repeat(64), delta: 1 },
    ]) {
        const result = applyCommand(base, command);
        assert.ok(result.rejected, JSON.stringify(command));
        assert.deepEqual(result.state, base, JSON.stringify(command));
    }
});

test('parseReceipts understands the documented forms', () => {
    const text = '正文 [[gold:+10]] 还有 [[exp:-5]] 与 [[item:药水:+2]]，以及 [[item:回血药水:-1]]';
    assert.deepEqual(parseReceipts(text).map(command => [command.op, command.name, command.delta]), [
        ['gold', undefined, '+10'],
        ['exp', undefined, '-5'],
        ['item', '药水', '+2'],
        ['item', '回血药水', '-1'],
    ]);
    assert.deepEqual(parseReceipts('no receipts here'), []);
    assert.match(parseReceipts('[[item:+2]]')[0].rejected, /name and an amount/);
});

test('applyReceipts applies in order and reports rejections separately', () => {
    const result = applyReceipts(normalizeState(DEFAULT_STATE), '[[item:药水:+2]] [[gold:+10]] [[item:+1]] [[luck:+1]]');
    assert.deepEqual(result.state.items, { 药水: 2 });
    assert.equal(result.state.gold, 20);
    assert.equal(result.notes.length, 2);
    assert.equal(result.rejected.length, 2, 'bad syntax and unknown commands are surfaced, not swallowed');
});

test('describeState includes state, the receipt rules and the last changes', () => {
    const text = describeState({ level: 2, exp: 40, expNext: 150, gold: 7, items: { 药水: 3 } }, ['获得 药水 ×1']);
    assert.match(text, /Lv\.2/);
    assert.match(text, /经验 40\/150/);
    assert.match(text, /金币 7/);
    assert.match(text, /药水×3/);
    assert.match(text, /回执规则/);
    assert.match(text, /\[\[item:物品名:\+1\]\]/);
    assert.match(text, /最近变化.*获得 药水 ×1/);

    const plain = describeState(DEFAULT_STATE);
    assert.equal(plain.includes('最近变化'), false, 'no change line when nothing changed');
    assert.match(plain, /背包：空/);
});

test('panelLines summarises for the rendered panel', () => {
    assert.deepEqual(panelLines({ level: 1, exp: 0, expNext: 100, gold: 0, items: {} }), {
        heading: 'Lv.1　经验 0/100　金币 0',
        items: ['背包是空的'],
    });
    assert.deepEqual(panelLines({ level: 3, exp: 5, expNext: 300, gold: 2, items: { b: 1, a: 2 } }).items, ['a ×2', 'b ×1']);
});
