import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import ts from 'typescript'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

describe('code-check coverage', () => {
  it('parses TSX and reports TypeScript and React hook mistakes as advisory diagnostics', async () => {
    const eslint = new ESLint({ cwd: root })
    const [result] = await eslint.lintText(`
      import { useEffect } from 'react'
      export function Probe({ active }: { active: boolean }) {
        const unused: number = 1
        if (active) useEffect(() => {}, [])
        return <div />
      }
    `, { filePath: path.join(root, 'src/components/CodeCheckProbe.tsx') })
    expect(result.errorCount).toBe(0)
    expect(result.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: '@typescript-eslint/no-unused-vars', severity: 1 }),
      expect.objectContaining({ ruleId: 'react-hooks/rules-of-hooks', severity: 1 }),
    ]))
    expect(result.messages.some(message => message.fatal)).toBe(false)
  })

  it('checks the expanded strict Electron graph and catches an in-memory type mutation', () => {
    const file = path.join(root, 'tsconfig.electron.json')
    const raw = ts.readConfigFile(file, ts.sys.readFile)
    expect(raw.error).toBeUndefined()
    const config = ts.parseJsonConfigFileContent(raw.config, ts.sys, root)
    expect(config.errors).toEqual([])
    expect(config.options).toMatchObject({ strict: true, checkJs: true, noEmit: true })
    expect(config.fileNames.length).toBeGreaterThanOrEqual(9)
    const target = path.join(root, 'electron/bin-guard.cjs')
    expect(config.fileNames).toContain(target)
    const host = ts.createCompilerHost(config.options)
    const getSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
      if (name !== target) return getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile)
      const text = ts.sys.readFile(name) + '\n/** @type {number} */ const __typeGateProbe = "not-a-number"\n'
      return ts.createSourceFile(name, text, languageVersion, true)
    }
    const program = ts.createProgram(config.fileNames, config.options, host)
    expect(ts.getPreEmitDiagnostics(program)).toEqual([
      expect.objectContaining({ code: 2322, file: expect.objectContaining({ fileName: target }) }),
    ])
  })
})
