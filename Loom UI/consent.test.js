import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CONSENT_CONTAINER_ID,
    CONSENT_VIEW_ID,
    buildConsentNodes,
    describeContract,
    summarizeRequests,
} from './consent.js';

const extensions = [
    { id: 'demo', name: 'Demo Extension' },
    { id: 'loom-host', name: 'Loom Host Adapter' },
];
const capabilities = [
    { extensionId: 'loom-host', id: 'settings.set', permissions: ['host.settings.write'] },
    { extensionId: 'loom-host', id: 'settings.remove', permissions: ['host.settings.write'] },
    { extensionId: 'loom-host', id: 'chat.messages', permissions: ['host.chat.read'] },
];

const requests = [
    { id: 'perm-2', extensionId: 'demo', permission: 'host.chat.read', reason: '读取聊天上下文' },
    { id: 'perm-1', extensionId: 'demo', permission: 'host.settings.write', reason: '' },
];

test('summarizes requests with extension names and the capabilities that declare them', () => {
    const summaries = summarizeRequests({ requests, extensions, capabilities });

    assert.deepEqual(summaries.map(summary => summary.id), ['perm-2', 'perm-1']);
    assert.deepEqual(summaries[0].declaredBy, ['loom-host:chat.messages']);
    assert.deepEqual(summaries[0].contracts, [{
        id: 'loom-host:chat.messages',
        input: '无',
        output: '无',
    }], 'capabilities without declared contracts report 无');
    assert.equal(summaries[0].extensionId, 'demo');
    assert.equal(summaries[0].extensionName, 'Demo Extension');
    assert.equal(summaries[0].permission, 'host.chat.read');
    assert.equal(summaries[0].reason, '读取聊天上下文');
    assert.deepEqual(summaries[1].declaredBy, ['loom-host:settings.remove', 'loom-host:settings.set']);
    assert.equal(summaries[1].reason, '');
});

test('describes capability contracts compactly', () => {
    assert.equal(describeContract(null), '无');
    assert.equal(describeContract({ type: 'null' }), 'null');
    assert.equal(describeContract({ type: 'array', items: { type: 'string' } }), '数组<string>');
    assert.equal(describeContract({
        type: 'object',
        required: ['name', 'uid'],
        properties: { name: { type: 'string' }, uid: { type: 'string' } },
    }), '{ name, uid }');
    assert.equal(describeContract({
        type: 'object',
        required: ['a', 'b', 'c', 'd', 'e'],
        properties: { a: {}, b: {}, c: {}, d: {}, e: {} },
    }), '{ a, b, c, d, +1 }', 'long required lists are truncated');
    assert.equal(describeContract({ type: 'object', properties: { key: { type: 'string' } } }), '{ key }');
    assert.equal(describeContract({ type: 'object' }), '空对象');
    assert.equal(describeContract({ type: 'string', enum: ['a'] }), 'string 枚举');
    assert.equal(describeContract({ type: ['string', 'null'] }), 'string|null');
});

test('falls back to the extension id and flags undeclared permissions', () => {
    const summaries = summarizeRequests({
        requests: [{ id: 'perm-9', extensionId: 'ghost', permission: 'demo.custom' }],
        extensions,
        capabilities,
    });
    assert.equal(summaries[0].extensionName, 'ghost');
    assert.deepEqual(summaries[0].declaredBy, []);

    const nodes = buildConsentNodes(summaries, {});
    const texts = JSON.stringify(nodes);
    assert.match(texts, /当前没有能力声明该权限/);
});

test('sorts requests so the prompt order is stable', () => {
    const summaries = summarizeRequests({
        requests: [
            { id: 'a', extensionId: 'loom-host', permission: 'host.chat.read' },
            { id: 'b', extensionId: 'demo', permission: 'host.settings.write' },
            { id: 'c', extensionId: 'demo', permission: 'host.chat.read' },
        ],
        extensions,
        capabilities,
    });
    assert.deepEqual(summaries.map(summary => summary.id), ['c', 'b', 'a']);
});

test('builds nothing when there is nothing to ask', () => {
    assert.equal(buildConsentNodes([], {}), null);
    assert.equal(buildConsentNodes(), null);
});

test('builds a card with one approve/deny pair per request', () => {
    const summaries = summarizeRequests({ requests, extensions, capabilities });
    const nodes = buildConsentNodes(summaries, { approve: () => {}, deny: () => {} });

    assert.equal(nodes.component, 'card');
    assert.match(nodes.props.title, /权限请求/);
    assert.match(nodes.props.subtitle, /2 个扩展/);
    assert.equal(nodes.children.length, 2);

    const labels = [];
    const walk = node => {
        if (node.component === 'button') labels.push(node.props.label);
        for (const child of node.children ?? []) walk(child);
    };
    walk(nodes);
    assert.deepEqual(labels, ['允许', '拒绝', '允许', '拒绝']);
});

test('wires each button to its own request id', () => {
    const summaries = summarizeRequests({ requests, extensions, capabilities });
    const approved = [];
    const denied = [];
    const nodes = buildConsentNodes(summaries, {
        approve: requestId => approved.push(requestId),
        deny: requestId => denied.push(requestId),
    });

    const buttons = [];
    const walk = node => {
        if (node.component === 'button') buttons.push(node);
        for (const child of node.children ?? []) walk(child);
    };
    walk(nodes);

    buttons[0].on.click();
    buttons[3].on.click();
    assert.deepEqual(approved, ['perm-2'], 'the first row approves its own request');
    assert.deepEqual(denied, ['perm-1'], 'the second row denies its own request');
});

test('missing handlers do not throw', () => {
    const summaries = summarizeRequests({ requests, extensions, capabilities });
    const nodes = buildConsentNodes(summaries, {});
    const buttons = [];
    const walk = node => {
        if (node.component === 'button') buttons.push(node);
        for (const child of node.children ?? []) walk(child);
    };
    walk(nodes);
    assert.doesNotThrow(() => buttons[0].on.click());
});

test('includes the reason and falls back when it is missing', () => {
    const summaries = summarizeRequests({ requests, extensions, capabilities });
    const nodes = buildConsentNodes(summaries, {});
    const texts = [];
    const walk = node => {
        if (node.component === 'text') texts.push(node.props.text);
        for (const child of node.children ?? []) walk(child);
    };
    walk(nodes);
    assert.ok(texts.includes('读取聊天上下文'));
    assert.ok(texts.includes('未提供理由。'));
});

test('exposes stable ids for the container and the view', () => {
    assert.equal(CONSENT_CONTAINER_ID, 'loom_consent');
    assert.equal(CONSENT_VIEW_ID, 'loom-consent');
});
