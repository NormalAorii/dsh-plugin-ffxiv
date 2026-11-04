/** Shared types for the FFXIV tool plugin (defineTool-compatible, no runtime deps). @module dsh-plugin-ffxiv/core/types */
/** Build one text content block. */
export function text(value) {
    return { type: 'text', text: value };
}
/** Prefix any thrown value with the tool name exactly once. */
export function toolError(name, error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith(`${name}:`))
        return error instanceof Error ? error : new Error(message);
    return new Error(`${name}: ${message}`);
}
