/** Process-wide item name → itemId cache shared by all tools. @module dsh-plugin-ffxiv/core/cache */
const byName = new Map();
const byId = new Map();
/** Normalize a Chinese item name for cache keys (strip all whitespace, lowercase). */
export function normalizeItemName(raw) {
    return raw.replace(/\s+/g, '').toLowerCase();
}
/** Look up one cached item by an already-normalized or raw name. */
export function getCachedItem(name) {
    return byName.get(normalizeItemName(name));
}
/** Cache one name → item mapping. */
export function setCachedItem(name, item) {
    const key = normalizeItemName(name);
    if (key.length > 0)
        byName.set(key, item);
    byName.set(normalizeItemName(item.name), item);
    byId.set(item.id, item);
}
/** Look up one cached item by numeric id. */
export function getCachedItemById(id) {
    return byId.get(id);
}
/** Number of cached items (used by the local verification script). */
export function itemCacheSize() {
    return byId.size;
}
