import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_ENTRY_ID, buildSettingsEntryHtml, summarizeForSettings } from './settings.js';

test('builds a settings drawer with the expected ids and text', () => {
    const html = buildSettingsEntryHtml({
        version: '9.9.9',
        extensionCount: 2,
        capabilityCount: 4,
        conflictCount: 1,
        hostStatus: '已连接',
    });

    assert.match(html, new RegExp(`id="${SETTINGS_ENTRY_ID}"`));
    assert.match(html, /class="loom_settings_entry inline-drawer"/);
    assert.match(html, /class="inline-drawer-content" style="display: none;"/);
    assert.match(html, /id="loom_settings_open"/);
    assert.match(html, /9\.9\.9/);
    assert.match(html, /2<\/span> \/ <span id="loom_settings_capabilities">4/);
    assert.match(html, /已连接/);
});

test('escapes unsafe values in the settings drawer markup', () => {
    const html = buildSettingsEntryHtml({ hostStatus: '<script>bad</script>', version: '1<2' });
    assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
});

test('summarizes runtime info into a settings payload', () => {
    assert.deepEqual(
        summarizeForSettings({ version: '1.2.3', extensionCount: 1, capabilityCount: 3 }, 2, '已连接'),
        { version: '1.2.3', extensionCount: 1, capabilityCount: 3, conflictCount: 2, hostStatus: '已连接' },
    );
    assert.deepEqual(summarizeForSettings(), {
        version: '0.0.0', extensionCount: 0, capabilityCount: 0, conflictCount: 0, hostStatus: '未连接',
    });
});
