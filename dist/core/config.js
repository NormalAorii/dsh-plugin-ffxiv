/** Optional local config file support for endpoints and credentials. @module dsh-plugin-ffxiv/core/config */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
let cached;
/** Enumerate the config-file candidates in priority order. */
function candidatePaths() {
    const paths = [];
    const explicit = process.env.FFXIV_CONFIG_FILE;
    if (explicit && explicit.trim().length > 0)
        paths.push(explicit.trim());
    const home = process.env.USERPROFILE ?? process.env.HOME;
    if (home) {
        const profile = process.env.DSH_PROFILE?.trim();
        if (profile)
            paths.push(join(home, '.dsh', 'profiles', profile, 'ffxiv-plugin.json'));
        paths.push(join(home, '.dsh', 'ffxiv-plugin.json'));
    }
    return paths;
}
/** Read and cache the first readable plugin config file (JSON object). */
function loadConfig() {
    const paths = candidatePaths();
    const signature = paths.join('|');
    if (cached && cached.signature === signature)
        return cached.value;
    let value;
    for (const path of paths) {
        try {
            if (!existsSync(path))
                continue;
            const parsed = JSON.parse(readFileSync(path, 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                value = parsed;
                break;
            }
        }
        catch {
            // An unreadable or malformed config file is ignored; env vars still work.
        }
    }
    cached = { signature, value };
    return value;
}
/** Read one dot-separated string value from the plugin config file. */
export function configString(path) {
    const config = loadConfig();
    if (!config)
        return undefined;
    let node = config;
    for (const key of path.split('.')) {
        if (!node || typeof node !== 'object')
            return undefined;
        node = node[key];
    }
    if (typeof node !== 'string')
        return undefined;
    const value = node.trim();
    return value.length > 0 ? value : undefined;
}
