import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './dom.js';

test('escapes html-sensitive characters', () => {
    assert.equal(escapeHtml('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(0), '0');
});