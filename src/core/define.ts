/** defineTool adapter: real @deepseek-ai/dsh-tools when resolvable, compatible fallback otherwise. @module dsh-plugin-ffxiv/core/define */

import type { DefineToolFn, ExecuteContext, ParamSpec, ToolSpec, ValueSpec } from './types.js'
import { toolError } from './types.js'

/** Compile one value-schema node to the enforced raw JSON Schema subset. */
export function compileValue(spec: ValueSpec): Record<string, unknown> {
  if (!spec || typeof spec !== 'object') return {}
  if (Array.isArray(spec.oneOf)) {
    return {
      oneOf: spec.oneOf.map((branch) => compileValue(branch)),
      ...annotations(spec),
    }
  }
  const type = spec.type
  if (!type || type === 'json') return { ...annotations(spec) }
  if (type === 'object') {
    const properties: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(spec.properties ?? {})) {
      properties[key] = compileValue(child)
    }
    const required = Array.isArray(spec.required) ? [...spec.required] : []
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: spec.additionalProperties ?? false,
      ...annotations(spec),
    }
  }
  if (type === 'array') {
    return {
      type: 'array',
      ...(spec.items ? { items: compileValue(spec.items) } : {}),
      ...annotations(spec),
    }
  }
  return {
    type,
    ...(Array.isArray(spec.enum) ? { enum: spec.enum } : {}),
    ...(spec.const !== undefined ? { const: spec.const } : {}),
    ...annotations(spec),
  }
}

/** Copy JSON-Schema annotation keywords without validating them. */
function annotations(spec: ValueSpec): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (spec.description) result.description = spec.description
  if (spec.title) result.title = spec.title
  if (spec.default !== undefined) result.default = spec.default
  return result
}

/**
 * Project one author value-schema node onto the `@deepseek-ai/dsh-tools`
 * value-schema DSL, which expresses object requiredness as per-property
 * `required: true` instead of an object-level `required` array.
 */
export function toDshToolsValueSpec(spec: ValueSpec): unknown {
  if (!spec || typeof spec !== 'object') return { type: 'json' }
  if (Array.isArray(spec.oneOf)) {
    return { oneOf: spec.oneOf.map((branch) => toDshToolsValueSpec(branch)), ...annotations(spec) }
  }
  const type = spec.type
  if (!type) return { type: 'json', ...annotations(spec) }
  if (type === 'object') {
    const required = new Set<string>(Array.isArray(spec.required) ? spec.required : [])
    const properties: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(spec.properties ?? {})) {
      const projected = toDshToolsValueSpec(child) as Record<string, unknown>
      if (required.has(key)) projected.required = true
      properties[key] = projected
    }
    return {
      type: 'object',
      properties,
      additionalProperties: spec.additionalProperties ?? false,
      ...annotations(spec),
    }
  }
  if (type === 'array') {
    return {
      type: 'array',
      ...(spec.items ? { items: toDshToolsValueSpec(spec.items) } : {}),
      ...annotations(spec),
    }
  }
  if (type === 'json') return { type: 'json', ...annotations(spec) }
  return {
    type,
    ...(Array.isArray(spec.enum) ? { enum: spec.enum } : {}),
    ...(spec.const !== undefined ? { const: spec.const } : {}),
    ...annotations(spec),
  }
}

/** Compile the compact parameter map into one open object root. */
export function compileParameters(parameters: Record<string, ParamSpec>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, spec] of Object.entries(parameters)) {
    properties[key] = compileValue(spec as ValueSpec)
    if (spec.required === true) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * Build a `defineTool`-compatible factory for hosts where
 * `@deepseek-ai/dsh-tools` is not resolvable. It emits a standard JSON-Schema
 * tool definition, which the Harness registry accepts directly.
 */
export function createFallbackDefineTool(): DefineToolFn {
  return (spec: ToolSpec) =>
    ({
      name: spec.name,
      description: spec.description,
      parameters: compileParameters(spec.parameters),
      output: {
        schema: compileValue(spec.output.schema),
        render: spec.output.render,
      },
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      execute: spec.execute,
    }) as unknown
}

/** Wrap one tool body so every thrown error carries the exact tool name once. */
export function guardTool(
  name: string,
  body: (args: any, ctx: ExecuteContext) => Promise<unknown>,
): (args: any, ctx: ExecuteContext) => Promise<unknown> {
  return async (args, ctx) => {
    try {
      return await body(args ?? {}, ctx)
    } catch (error) {
      throw toolError(name, error)
    }
  }
}

/** Read one required string argument, throwing a readable message when absent. */
export function requireString(args: any, key: string, label: string): string {
  const value = args?.[key]
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) throw new Error(`${label}不能为空`)
  return text
}

/** Read one optional string argument. */
export function optionalString(args: any, key: string): string | undefined {
  const value = args?.[key]
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 ? text : undefined
}
