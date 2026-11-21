/**
 * Generate `extensions/index.json` from the packages checked into `extensions/`.
 *
 * A browser cannot list a directory, so discovery needs a manifest index. This
 * script is the only build step in the project: it scans `extensions/<id>/manifest.json`,
 * validates the minimal package contract, and writes a deterministic index (sorted,
 * no timestamps) so a regenerated file only changes when a package does.
 *
 *   npm run extensions:index
 *
 * Package contract (`extensions/<id>/`):
 *   manifest.json  { id, name, version, entry, description?, dependencies?, permissions? }
 *   index.js       ES module; default export = { activate?, deactivate? } or a factory
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INDEX_VERSION = 1;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const PERMISSION_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/i;

/** Validate one package directory and return its index entry. */
export function readPackage(extensionsDir, directory) {
    const packageDir = path.join(extensionsDir, directory);
    const manifestPath = path.join(packageDir, 'manifest.json');
    const problems = [];

    let manifest;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        return { id: directory, problems: [`manifest.json is not readable JSON: ${error.message}`] };
    }

    if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) {
        problems.push('manifest.id must match /^[a-z0-9][a-z0-9._-]*$/i');
    }
    if (manifest.id !== directory) {
        problems.push(`manifest.id "${manifest.id}" must equal its directory name "${directory}"`);
    }
    if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
        problems.push('manifest.name must be a non-empty string');
    }
    if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
        problems.push('manifest.version must be a non-empty string');
    }
    if (typeof manifest.entry !== 'string' || !manifest.entry.endsWith('.js')) {
        problems.push('manifest.entry must point at a .js module');
    } else if (!existsSync(path.join(packageDir, manifest.entry))) {
        problems.push(`manifest.entry "${manifest.entry}" does not exist`);
    }
    for (const dependency of manifest.dependencies ?? []) {
        if (typeof dependency !== 'string' || !ID_PATTERN.test(dependency)) {
            problems.push(`dependencies must be extension ids, got ${JSON.stringify(dependency)}`);
        }
    }
    for (const permission of manifest.permissions ?? []) {
        if (typeof permission !== 'string' || !PERMISSION_PATTERN.test(permission)) {
            problems.push(`permissions must be permission names, got ${JSON.stringify(permission)}`);
        }
    }

    if (problems.length > 0) return { id: directory, problems };
    return {
        id: manifest.id,
        problems: [],
        entry: {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            description: manifest.description ?? '',
            manifest: `extensions/${directory}/manifest.json`,
            entry: `extensions/${directory}/${manifest.entry}`,
            dependencies: manifest.dependencies ?? [],
            permissions: manifest.permissions ?? [],
        },
    };
}

/** Scan a `extensions/` directory. Returns the index document and per-package problems. */
export function buildIndex(extensionsDir) {
    if (!existsSync(extensionsDir)) {
        return { index: { version: INDEX_VERSION, extensions: [] }, problems: [] };
    }

    const problems = [];
    const entries = [];
    const seen = new Map();

    for (const directory of readdirSync(extensionsDir, { withFileTypes: true })) {
        if (!directory.isDirectory()) continue;
        const result = readPackage(extensionsDir, directory.name);
        if (result.problems.length > 0) {
            problems.push({ directory: directory.name, problems: result.problems });
            continue;
        }
        if (seen.has(result.entry.id)) {
            problems.push({ directory: directory.name, problems: [`duplicate id "${result.entry.id}"`] });
            continue;
        }
        seen.set(result.entry.id, result.entry);
        entries.push(result.entry);
    }

    entries.sort((left, right) => left.id.localeCompare(right.id));
    return { index: { version: INDEX_VERSION, extensions: entries }, problems };
}

export function renderIndex(index) {
    return `${JSON.stringify(index, null, 2)}\n`;
}

function main() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = path.resolve(here, '..');
    const extensionsDir = path.join(root, 'extensions');
    const { index, problems } = buildIndex(extensionsDir);

    writeFileSync(path.join(extensionsDir, 'index.json'), renderIndex(index));

    for (const problem of problems) {
        console.error(`extensions/${problem.directory}: ${problem.problems.join('; ')}`);
    }
    console.log(`indexed ${index.extensions.length} extension(s): ${index.extensions.map(entry => entry.id).join(', ') || '(none)'}`);
    if (problems.length > 0) {
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
