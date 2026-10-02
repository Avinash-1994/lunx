
/**
 * Lunx Marketplace Database
 *
 * Local plugin registry, backed by a JSON record collection rather than
 * SQLite. The registry holds tens of rows and only ever did lookups by
 * (name, version) plus a substring search, so the native addon bought nothing.
 * See `src/lib/store.ts`.
 */

import * as fs from 'fs';
import path from 'path';
import { RecordStore } from '../lib/store.js';

const DB_PATH = path.resolve('.lunx-marketplace.json');
const ARTIFACT_ROOT = path.resolve('.lunx-marketplace-artifacts');

export interface PluginRecord {
    name: string;
    version: string;
    description: string;
    author: string;
    hash: string;
    signature: string;
    public_key: string;
    permissions_json: string;
    artifact_path?: string;
    created_at: string;
}

/** Stored shape: the record plus the `name@version` primary key. */
type PluginRow = PluginRecord & { id: string };

function rowId(name: string, version: string): string {
    return `${name}@${version}`;
}

function toRecord(row: PluginRow): PluginRecord {
    const { id: _id, ...record } = row;
    return record;
}

/** Newest first, matching the old `ORDER BY datetime(created_at) DESC, version DESC`. */
function byNewest(a: PluginRow, b: PluginRow): number {
    const at = Date.parse(a.created_at);
    const bt = Date.parse(b.created_at);
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at;
    return b.version.localeCompare(a.version, undefined, { numeric: true });
}

export class MarketplaceDB {
    private readonly store: RecordStore<PluginRow>;

    constructor(dbPath: string = DB_PATH) {
        this.store = new RecordStore<PluginRow>(dbPath);
        fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });
    }

    private ensureArtifactDirectory(name: string, version: string) {
        const pluginDir = path.join(ARTIFACT_ROOT, name, version);
        fs.mkdirSync(pluginDir, { recursive: true });
        return pluginDir;
    }

    publish(plugin: PluginRecord, artifactBuffer?: Buffer): void {
        if (artifactBuffer) {
            const artifactDir = this.ensureArtifactDirectory(plugin.name, plugin.version);
            const artifactPath = path.join(artifactDir, 'plugin.wasm');
            fs.writeFileSync(artifactPath, artifactBuffer);
            plugin.artifact_path = artifactPath;
        }

        this.store.put({
            ...plugin,
            // The old schema defaulted created_at to CURRENT_TIMESTAMP.
            created_at: plugin.created_at || new Date().toISOString(),
            id: rowId(plugin.name, plugin.version),
        });
    }

    search(query: string): PluginRecord[] {
        const needle = query.toLowerCase();
        return this.store
            .find(
                (row) =>
                    row.name.toLowerCase().includes(needle) ||
                    (row.description ?? '').toLowerCase().includes(needle) ||
                    row.author.toLowerCase().includes(needle),
            )
            .slice(0, 50)
            .map(toRecord);
    }

    get(name: string, version?: string): PluginRecord | undefined {
        if (version) {
            const row = this.store.get(rowId(name, version));
            return row ? toRecord(row) : undefined;
        }
        const newest = this.store.find((row) => row.name === name).sort(byNewest)[0];
        return newest ? toRecord(newest) : undefined;
    }

    listVersions(name: string): PluginRecord[] {
        return this.store
            .find((row) => row.name === name)
            .sort(byNewest)
            .map(toRecord);
    }

    getArtifact(name: string, version?: string): Buffer | undefined {
        const plugin = this.get(name, version);
        if (!plugin || !plugin.artifact_path) return undefined;
        if (!fs.existsSync(plugin.artifact_path)) return undefined;
        return fs.readFileSync(plugin.artifact_path);
    }
}

export const marketplaceDB = new MarketplaceDB();
