/**
 * Character panel model — pure state handling for the demo extension.
 *
 * Everything in this file is string/number arithmetic with no DOM and no host
 * access, so the rules (level-up, receipt parsing, prompt wording) can be tested
 * without a browser. `index.js` only moves this data in and out of Loom.
 */

// Marker characters come from Core so the panel and the framework cannot disagree
// about the block grammar.
import { BLOCK_CLOSE, BLOCK_ID_PATTERN, BLOCK_OPEN } from '../../Loom%20Core/markers.js';

export const DEFAULT_STATE = Object.freeze({
    level: 1,
    exp: 0,
    expNext: 100,
    gold: 10,
    items: Object.freeze({}),
});

const ITEM_LIMIT = 50;
const ITEM_NAME_LIMIT = 24;

/** Coerce a persisted value into a usable state; anything odd falls back. */
export function normalizeState(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return cloneDefault();
    const items = {};
    if (raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items)) {
        for (const [name, count] of Object.entries(raw.items)) {
            if (typeof name !== 'string' || name.trim() === '') continue;
            const value = Number.isFinite(count) ? Math.trunc(count) : 0;
            if (value > 0) items[name] = value;
        }
    }
    return {
        level: positiveInt(raw.level, DEFAULT_STATE.level),
        exp: Math.max(0, Math.trunc(Number(raw.exp) || 0)),
        expNext: positiveInt(raw.expNext, DEFAULT_STATE.expNext),
        gold: Math.max(0, Math.trunc(Number(raw.gold) || 0)),
        items,
    };
}

function cloneDefault() {
    return { ...DEFAULT_STATE, items: {} };
}

function positiveInt(value, fallback) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** Level-up loop: one receipt can cross several levels. */
function settleExp(state) {
    let { level, exp, expNext } = state;
    let levels = 0;
    while (exp >= expNext) {
        exp -= expNext;
        level += 1;
        expNext = Math.max(expNext + 1, Math.round(expNext * 1.5));
        levels += 1;
    }
    return { state: { ...state, level, exp, expNext }, levels };
}

/**
 * Apply one parsed command. Returns the new state plus a human note for the
 * prompt; an invalid command is reported, never silently dropped.
 */
export function applyCommand(state, command) {
    const current = normalizeState(state);
    if (!command || typeof command !== 'object') {
        return { state: current, note: '', rejected: 'empty command' };
    }
    const delta = Math.trunc(Number(command.delta));
    if (!Number.isFinite(delta) || delta === 0) {
        return { state: current, note: '', rejected: `invalid amount: ${command.delta}` };
    }

    if (command.op === 'gold') {
        const gold = Math.max(0, current.gold + delta);
        return { state: { ...current, gold }, note: `金币 ${delta > 0 ? '+' : ''}${delta}（现 ${gold}）` };
    }

    if (command.op === 'exp') {
        const settled = settleExp({ ...current, exp: current.exp + delta });
        const note = settled.levels > 0
            ? `经验 ${delta > 0 ? '+' : ''}${delta}，升级 ${settled.levels} 级（现 Lv.${settled.state.level}）`
            : `经验 ${delta > 0 ? '+' : ''}${delta}（${settled.state.exp}/${settled.state.expNext}）`;
        return { state: settled.state, note };
    }

    if (command.op === 'level') {
        const level = Math.max(1, current.level + delta);
        if (level === current.level) {
            return { state: current, note: '', rejected: 'level would not change' };
        }
        return { state: { ...current, level }, note: `等级 ${delta > 0 ? '+' : ''}${delta}（现 Lv.${level}）` };
    }

    if (command.op === 'item') {
        const name = typeof command.name === 'string' ? command.name.trim() : '';
        if (!name || name.length > ITEM_NAME_LIMIT) {
            return { state: current, note: '', rejected: `invalid item name: ${command.name}` };
        }
        const items = { ...current.items };
        const next = Math.max(0, (items[name] ?? 0) + delta);
        if (next === 0) delete items[name];
        else items[name] = next;
        if (Object.keys(items).length > ITEM_LIMIT) {
            return { state: current, note: '', rejected: `too many distinct items (limit ${ITEM_LIMIT})` };
        }
        const verb = delta > 0 ? '获得' : '失去';
        return { state: { ...current, items }, note: `${verb} ${name} ×${Math.abs(delta)}（现 ${next}）` };
    }

    return { state: current, note: '', rejected: `unknown command: ${command.op}` };
}

const RECEIPT_PATTERN = /\[\[\s*([a-z]+)\s*(?::\s*([^\]]*?))?\s*\]\]/gi;

/**
 * Find receipt commands in text.
 *
 * Grammar (deliberately plain so a model can imitate it, and short so leaving it in
 * the message costs almost nothing):
 *
 *   [[gold:+10]]  [[exp:+50]]  [[level:+1]]  [[item:药水:+2]]  [[item:药水:-1]]
 *
 * A trailing colon-separated amount is required for `item`; the other commands take
 * one number.
 */
export function parseReceipts(text) {
    if (typeof text !== 'string' || text === '') return [];
    const commands = [];
    RECEIPT_PATTERN.lastIndex = 0;
    let match;
    while ((match = RECEIPT_PATTERN.exec(text)) !== null) {
        const op = match[1].toLowerCase();
        const body = (match[2] ?? '').trim();
        if (op === 'item') {
            const separator = body.lastIndexOf(':');
            if (separator < 0) {
                commands.push({ op, raw: match[0], rejected: 'item needs a name and an amount' });
                continue;
            }
            commands.push({
                op,
                name: body.slice(0, separator).trim(),
                delta: body.slice(separator + 1).trim(),
                raw: match[0],
            });
        } else {
            commands.push({ op, delta: body, raw: match[0] });
        }
    }
    return commands;
}

/** Apply every receipt found in `text`, returning notes and anything rejected. */
export function applyReceipts(state, text) {
    let current = normalizeState(state);
    const notes = [];
    const rejected = [];
    for (const command of parseReceipts(text)) {
        if (command.rejected) {
            rejected.push({ raw: command.raw, reason: command.rejected });
            continue;
        }
        const result = applyCommand(current, command);
        current = result.state;
        if (result.rejected) rejected.push({ raw: command.raw, reason: result.rejected });
        else if (result.note) notes.push(result.note);
    }
    return { state: current, notes, rejected };
}

/** Marker for a block kind; the panel is a pointer block, so no payload is needed. */
export function panelMarkerFor(kind) {
    if (typeof kind !== 'string' || !BLOCK_ID_PATTERN.test(kind)) {
        throw new TypeError('Block kind must be an identifier.');
    }
    return `${BLOCK_OPEN}loom:${kind}${BLOCK_CLOSE}${BLOCK_OPEN}/loom${BLOCK_CLOSE}`;
}

/** Does any message in the chat carry this panel's marker? */
export function hasPanelMarker(messages, kind) {
    if (!Array.isArray(messages)) return false;
    const needle = `${BLOCK_OPEN}loom:${kind}${BLOCK_CLOSE}`;
    return messages.some(message => String(message?.mes ?? '').includes(needle));
}

/** One-line-per-entry summary of the panel contents. */
export function panelLines(state) {
    const current = normalizeState(state);
    const entries = Object.entries(current.items)
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([name, count]) => `${name} ×${count}`);
    return {
        heading: `Lv.${current.level}　经验 ${current.exp}/${current.expNext}　金币 ${current.gold}`,
        items: entries.length > 0 ? entries : ['背包是空的'],
    };
}

/**
 * Natural-language prompt for the model.
 *
 * `changes` are the notes from the last mutation, so the model learns what just
 * happened without reading the whole state every turn.
 */
export function describeState(state, changes = []) {
    const current = normalizeState(state);
    const items = Object.entries(current.items)
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([name, count]) => `${name}×${count}`)
        .join('、');
    const lines = [
        `【角色状态】Lv.${current.level}｜经验 ${current.exp}/${current.expNext}｜金币 ${current.gold}｜背包：${items || '空'}`,
        '【回执规则】需要改变角色状态时，在回复末尾追加一行（可多行）：[[item:物品名:+1]] 增加物品、[[item:物品名:-1]] 消耗物品、[[gold:+10]] 金币变化、[[exp:+50]] 获得经验、[[level:+1]] 等级变化。',
    ];
    if (changes.length > 0) lines.push(`【最近变化】${changes.join('；')}`);
    return lines.join('\n');
}
