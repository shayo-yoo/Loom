import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRuntimeInfo } from '../Loom%20Core/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

test('manifest and package versions stay in sync with the runtime version', () => {
    const runtimeVersion = getRuntimeInfo().version;
    assert.equal(readJson('manifest.json').version, runtimeVersion);
    assert.equal(readJson('package.json').version, runtimeVersion);
    assert.match(runtimeVersion, /^\d+\.\d+\.\d+$/);
});

test('the extension manifest points at loadable entry files', () => {
    const manifest = readJson('manifest.json');
    assert.equal(typeof manifest.display_name, 'string');
    assert.ok(fs.existsSync(path.join(root, manifest.js)), `missing extension script: ${manifest.js}`);
    assert.ok(fs.existsSync(path.join(root, manifest.css)), `missing extension style: ${manifest.css}`);
});
