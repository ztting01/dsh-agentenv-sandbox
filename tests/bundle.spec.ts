import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('profile bundle', () => {
  it('disables host permission presets for the fixed remote boundary', async () => {
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toMatch(
      /- id: permission\s+name: '@deepseek-ai\/dsh-permission-presets'\s+disabled: true/,
    )
  })
})
