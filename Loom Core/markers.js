/**
 * Loom blocks — a display-only region inside a message.
 *
 * A block is a marker an extension can embed in message text so that a UI can be
 * rendered in its place, while the block never reaches the model:
 *
 *   ⟦loom:widget⟧{"slot":"hud"}⟦/loom⟧   paired: content belongs to the block
 *   ⟦loom:hud⟧                          pointer: the content lives in Loom state
 *
 * Why this syntax: the delimiters (U+27E6/U+27E7) do not occur in normal prose,
 * survive SillyTavern's markdown/HTML handling as plain text, and are removed from
 * the prompt before the model sees them — so the model has no reason to imitate
 * them. The block id is an identifier, never a path or markup.
 *
 * This module is pure string handling: no DOM, no host access, so both the host
 * adapter (stripping from the prompt) and the UI (rendering in place of the block)
 * share one definition of what a block is.
 */

export const BLOCK_OPEN = '\u27E6';
export const BLOCK_CLOSE = '\u27E7';
const TOKEN_PATTERN = /\u27E6\/loom\u27E7|\u27E6loom:([a-z0-9][a-z0-9._-]*)\u27E7/gi;
export const BLOCK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** Text an extension embeds to mark a place for UI. */
export function formatBlock(kind, inner = null) {
    if (typeof kind !== 'string' || !BLOCK_ID_PATTERN.test(kind)) {
        throw new TypeError('Block kind must be an identifier.');
    }
    if (inner === null || inner === undefined) return `${BLOCK_OPEN}loom:${kind}${BLOCK_CLOSE}`;
    return `${BLOCK_OPEN}loom:${kind}${BLOCK_CLOSE}${inner}${BLOCK_OPEN}/loom${BLOCK_CLOSE}`;
}

/**
 * Find every block in `text`.
 *
 * Returns `{ kind, inner, from, to, pointer }` where `pointer` marks a bare marker
 * (no closing tag) and `from`/`to` are offsets into the original string. An
 * unclosed opening tag is reported as a pointer so a half-written block still gets
 * removed from the prompt instead of leaking its marker.
 */
export function parseBlocks(text) {
    if (typeof text !== 'string' || text === '') return [];
    const blocks = [];
    let pending = null;
    TOKEN_PATTERN.lastIndex = 0;
    let match;
    while ((match = TOKEN_PATTERN.exec(text)) !== null) {
        // Two token shapes: `⟦/loom⟧` closes, `⟦loom:<kind>⟧` opens.
        const kind = match[1] ? match[1].toLowerCase() : null;
        const from = match.index;
        const to = match.index + match[0].length;
        if (kind === null) {
            // A closing token pairs with the most recent opening one.
            if (pending) {
                blocks.push({
                    kind: pending.kind,
                    inner: text.slice(pending.to, from),
                    from: pending.from,
                    to,
                    pointer: false,
                });
                pending = null;
            }
            // A stray closing tag is ignored: it carries no content to remove.
            continue;
        }
        if (pending) {
            // A new block starts before the previous one closed: report the previous
            // as a pointer so nothing is silently swallowed.
            blocks.push({ kind: pending.kind, inner: '', from: pending.from, to: pending.to, pointer: true });
        }
        pending = { kind, from, to };
    }
    if (pending) {
        blocks.push({ kind: pending.kind, inner: '', from: pending.from, to: pending.to, pointer: true });
    }
    return blocks;
}

/** True when the text contains at least one Loom block. */
export function hasBlocks(text) {
    return parseBlocks(text).length > 0;
}

/**
 * Remove every block from `text`.
 *
 * `replacement(kind, inner)` may return text to keep in place of a block (for
 * example a compact state summary the model should still see). The default removes
 * the block entirely.
 */
export function stripBlocks(text, { replacement = null } = {}) {
    if (typeof text !== 'string' || text === '') return typeof text === 'string' ? text : '';
    const blocks = parseBlocks(text);
    if (blocks.length === 0) return text;
    let result = '';
    let cursor = 0;
    for (const block of blocks) {
        result += text.slice(cursor, block.from);
        if (typeof replacement === 'function') {
            const inserted = replacement(block.kind, block.inner);
            if (typeof inserted === 'string') result += inserted;
        }
        cursor = block.to;
    }
    return result + text.slice(cursor);
}

/**
 * Strip blocks from one prompt message, preserving the message shape.
 *
 * Chat-completion prompts are objects with `content`; text prompts are plain
 * strings. Anything else is returned untouched so an unexpected shape cannot be
 * corrupted.
 */
export function stripBlocksFromMessage(message, options) {
    if (typeof message === 'string') return stripBlocks(message, options);
    if (!message || typeof message !== 'object') return message;
    if (typeof message.content === 'string') {
        const content = stripBlocks(message.content, options);
        return content === message.content ? message : { ...message, content };
    }
    if (typeof message.mes === 'string') {
        const mes = stripBlocks(message.mes, options);
        return mes === message.mes ? message : { ...message, mes };
    }
    return message;
}
