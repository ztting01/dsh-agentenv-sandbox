import type { Sandbox } from 'e2b'

const METADATA_UNSUPPORTED = 'File metadata requires envd 0.6.2 or later.'

function metadataOptions(value: unknown): value is Record<string, unknown> & {
  metadata: unknown
} {
  return typeof value === 'object'
    && value !== null
    && Object.hasOwn(value, 'metadata')
}

function bindMember(target: object, property: PropertyKey): unknown {
  const value: unknown = Reflect.get(target, property, target)
  return typeof value === 'function' ? value.bind(target) : value
}

/**
 * Adapt E2B file-metadata writes to AgentENV releases whose envd predates 0.6.2.
 * @param sandbox - Raw SDK sandbox returned by AgentENV.
 * @returns A transparent SDK handle with one narrowly scoped write fallback.
 */
export function withAgentEnvCompatibility(sandbox: Sandbox): Sandbox {
  const rawFiles = sandbox.files
  const files = new Proxy(rawFiles, {
    get(target, property): unknown {
      if (property !== 'write') return bindMember(target, property)
      return async (...args: unknown[]): Promise<unknown> => {
        try {
          return await Reflect.apply(target.write, target, args)
        } catch (error: unknown) {
          const options = args.at(-1)
          if (!(error instanceof Error)
            || error.message !== METADATA_UNSUPPORTED
            || !metadataOptions(options)) {
            throw error
          }
          const { metadata: _unsupportedMetadata, ...compatibleOptions } = options
          return Reflect.apply(target.write, target, [...args.slice(0, -1), compatibleOptions])
        }
      }
    },
  })

  return new Proxy(sandbox, {
    get(target, property): unknown {
      if (property === 'files') return files
      return bindMember(target, property)
    },
  })
}
