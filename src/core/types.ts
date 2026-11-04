/** Shared types for the FFXIV tool plugin (defineTool-compatible, no runtime deps). @module dsh-plugin-ffxiv/core/types */

/** One model-facing text content block. */
export interface ContentBlock {
  type: 'text'
  text: string
}

/** Harness compact schema kinds supported by the shared DSL. */
export type ParamKind = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'json'

/** One parameter node in the Harness compact parameter DSL. */
export interface ParamSpec {
  type?: ParamKind
  description?: string
  title?: string
  /** Mark this property as required in the parent object. */
  required?: boolean
  default?: unknown
  examples?: unknown
  enum?: readonly (string | number | boolean | null)[]
  const?: string | number | boolean | null
  items?: ValueSpec
  properties?: Record<string, ParamSpec>
  additionalProperties?: boolean
}

/** One canonical output-schema node (JSON-Schema-like). */
export interface ValueSpec {
  type?: ParamKind
  description?: string
  title?: string
  default?: unknown
  enum?: readonly (string | number | boolean | null)[]
  const?: string | number | boolean | null
  oneOf?: readonly ValueSpec[]
  items?: ValueSpec
  properties?: Record<string, ValueSpec>
  required?: readonly string[]
  additionalProperties?: boolean
}

/** Declared output: enforced canonical schema plus a compact renderer. */
export interface OutputSpec {
  schema: ValueSpec
  render(args: any, value: any): ContentBlock[]
}

/** Execution context handed to every tool body. */
export interface ExecuteContext {
  signal: AbortSignal
}

/** One tool declaration in the compact authoring form. */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, ParamSpec>
  output: OutputSpec
  execute(args: any, ctx: ExecuteContext): Promise<unknown>
  timeoutMs?: number
}

/** The `defineTool` shape this plugin compiles against. */
export type DefineToolFn = (spec: ToolSpec) => unknown

/** Build one text content block. */
export function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

/** Prefix any thrown value with the tool name exactly once. */
export function toolError(name: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith(`${name}:`)) return error instanceof Error ? error : new Error(message)
  return new Error(`${name}: ${message}`)
}
