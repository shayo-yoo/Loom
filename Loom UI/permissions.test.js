import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PERMISSION_SECTION_ID,
    PERMISSION_TOGGLE_CLASS,
    buildPermissionSectionHtml,
    countGranted,
    summarizePermissions,
} from './permissions.js';

const capabilities = [
    { extensionId: 'loom-host', id: 'settings.set', permissions: ['host.settings.write'] },
    { extensionId: 'loom-host', id: 'settings.remove', permissions: ['host.settings.write'] },
    { extensionId: 'loom-host', id: 'context.snapshot', permissions: [] },
    { extensionId: 'demo', id: 'notes.write', permissions: ['demo.notes.write'] },
];

const extensions = [
    { id: 'loom-host', name: 'Loom Host Adapter' },
    { id: 'loom-ui', name: 'Loom UI' },
    { id: 'demo', name: 'Demo Extension' },
];

test('summarizes declared permissions with the capabilities that require them', () => {
    const rows = summarizePermissions({ capabilities, extensions, granted: [] });
    assert.deepEqual(rows.map(row => row.permission), ['demo.notes.write', 'host.settings.write']);

    const hostWrite = rows.find(row => row.permission === 'host.settings.write');
    assert.deepEqual(hostWrite.requiredBy, ['loom-host:settings.remove', 'loom-host:settings.set']);
    assert.deepEqual(hostWrite.holders.map(holder => holder.extensionId), ['demo', 'loom-host', 'loom-ui']);
    assert.equal(hostWrite.holders.every(holder => holder.granted === false), true);
});

test('joins grants per extension and permission', () => {
    const rows = summarizePermissions({
        capabilities,
        extensions,
        granted: [
            { extensionId: 'loom-ui', permissions: ['host.settings.write'] },
            { extensionId: 'demo', permissions: ['demo.notes.write'] },
        ],
    });

    const hostWrite = rows.find(row => row.permission === 'host.settings.write');
    assert.deepEqual(
        hostWrite.holders.filter(holder => holder.granted).map(holder => holder.extensionId),
        ['loom-ui'],
    );
    const notes = rows.find(row => row.permission === 'demo.notes.write');
    assert.deepEqual(notes.holders.filter(holder => holder.granted).map(holder => holder.extensionId), ['demo']);
});

test('falls back to the extension id when a display name is missing', () => {
    const rows = summarizePermissions({
        capabilities: [{ extensionId: 'loom-host', id: 'x', permissions: ['p.one'] }],
        extensions: [{ id: 'nameless' }, { id: 'named', name: 'Named' }],
        granted: [],
    });
    // Holders are sorted by extension id, so 'named' sorts before 'nameless'.
    assert.deepEqual(rows[0].holders.map(holder => holder.name), ['Named', 'nameless']);
});

test('returns an empty list when nothing declares a permission', () => {
    assert.deepEqual(summarizePermissions(), []);
    assert.deepEqual(summarizePermissions({ capabilities, extensions, granted: [] }).length, 2);
    assert.deepEqual(summarizePermissions({ capabilities: [{ extensionId: 'a', id: 'b', permissions: [] }] }), []);
    assert.deepEqual(summarizePermissions({ capabilities: [{ extensionId: 'a', id: 'b' }] }), []);
});

test('renders the empty state when no permission is declared', () => {
    const html = buildPermissionSectionHtml([]);
    assert.match(html, /没有能力声明额外权限/);
});

test('renders toggle buttons carrying the permission and extension ids', () => {
    const rows = summarizePermissions({
        capabilities,
        extensions,
        granted: [{ extensionId: 'loom-ui', permissions: ['host.settings.write'] }],
    });
    const html = buildPermissionSectionHtml(rows);

    assert.match(html, /host\.settings\.write/);
    assert.match(html, new RegExp(`class="menu_button ${PERMISSION_TOGGLE_CLASS}"`));
    assert.match(html, /data-permission="host\.settings\.write" data-extension="loom-ui" data-granted="true"/);
    assert.match(html, /data-permission="host\.settings\.write" data-extension="demo" data-granted="false"/);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /aria-pressed="false"/);
    assert.match(html, /loom-host:settings\.set/);
    assert.match(html, /已授权/);
    assert.match(html, /未授权/);
});

test('escapes permission and extension values in the section markup', () => {
    const html = buildPermissionSectionHtml([
        {
            permission: '<script>alert(1)</script>',
            requiredBy: ['a<b'],
            holders: [{ extensionId: '"quoted"', name: "'single'", granted: false }],
        },
    ]);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /a&lt;b/);
    assert.match(html, /&quot;quoted&quot;/);
    assert.match(html, /&#39;single&#39;/);
});

test('counts granted permission pairs', () => {
    const rows = summarizePermissions({
        capabilities,
        extensions,
        granted: [
            { extensionId: 'loom-ui', permissions: ['host.settings.write'] },
            { extensionId: 'demo', permissions: ['demo.notes.write', 'host.settings.write'] },
        ],
    });
    assert.equal(countGranted(rows), 3);
    assert.equal(countGranted([]), 0);
});

test('exposes a stable section id', () => {
    assert.equal(PERMISSION_SECTION_ID, 'loom_permissions');
});
