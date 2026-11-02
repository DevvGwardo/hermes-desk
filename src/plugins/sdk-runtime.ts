/**
 * Runtime SDK injection — ported from Hermes desktop's `sdk/runtime.ts`.
 *
 * Bundled plugins resolve `@hermes/plugin-sdk` via a vite alias; RUNTIME-loaded
 * plugins (disk) import the same specifier and get the same object: the loader
 * rewrites bare specifiers to shim modules that re-export the live namespaces
 * installed here. React ships as the app's singletons — a second React
 * instance would break hooks.
 */
import * as React from 'react'
import * as jsxDevRuntime from 'react/jsx-dev-runtime'
import * as jsxRuntime from 'react/jsx-runtime'

import * as sdk from './sdk'

const GLOBALS = {
  __HERMES_PLUGIN_SDK__: sdk,
  __HERMES_REACT__: React,
  __HERMES_REACT_JSX__: jsxRuntime,
  __HERMES_REACT_JSX_DEV__: jsxDevRuntime,
} as const

export function installPluginSdk(): void {
  Object.assign(globalThis, GLOBALS)
}

/** Build a shim ESM blob that re-exports a global namespace's live members. */
function shimUrl(globalKey: keyof typeof GLOBALS): string {
  const names = Object.keys(GLOBALS[globalKey]).filter(
    (name) => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name),
  )

  const source =
    `const m = globalThis.${globalKey};\n` +
    `export default m.default ?? m;\n` +
    (names.length ? `export const { ${names.join(', ')} } = m;\n` : '')

  return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
}

let cached: Record<string, string> | null = null

/** Specifier -> shim URL map for the runtime loader (longest keys first). */
export function sdkImportMap(): Record<string, string> {
  cached ??= {
    '@hermes/plugin-sdk': shimUrl('__HERMES_PLUGIN_SDK__'),
    'react/jsx-dev-runtime': shimUrl('__HERMES_REACT_JSX_DEV__'),
    'react/jsx-runtime': shimUrl('__HERMES_REACT_JSX__'),
    react: shimUrl('__HERMES_REACT__'),
  }

  return cached
}
