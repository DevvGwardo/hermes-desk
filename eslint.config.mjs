import js from '@eslint/js'
import security from 'eslint-plugin-security'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

// Establish real JS/TS diagnostics before making the legacy backlog a CI gate.
const advisoryRules = rules => Object.fromEntries(Object.entries(rules ?? {}).map(([name, rule]) =>
  [name, Array.isArray(rule) ? [rule[0] === 'off' || rule[0] === 0 ? 'off' : 'warn', ...rule.slice(1)]
    : rule === 'off' || rule === 0 ? 'off' : 'warn']))

const unusedVarsOptions = {
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
  destructuredArrayIgnorePattern: '^_',
  ignoreRestSiblings: true,
}

export default [
  { ...js.configs.recommended, rules: advisoryRules(js.configs.recommended.rules) },
  ...tseslint.configs.recommended.map(config => ({
    ...config, files: ['src/**/*.{ts,tsx}', 'electron/**/*.{ts,tsx}'],
    ...(config.rules ? { rules: advisoryRules(config.rules) } : {}),
  })),
  // A leading underscore marks a binding as intentionally unused (callback
  // signatures, omitted tuple slots); rest siblings omit keys from a copy.
  {
    files: ['**/*.{js,cjs,mjs}'],
    rules: { 'no-unused-vars': ['warn', unusedVarsOptions] },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'electron/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-unused-vars': ['warn', unusedVarsOptions] },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    plugins: {
      security,
    },
    rules: {
      ...advisoryRules(security.configs.recommended.rules),
      // these are all validated by fs-guard.cjs / validateFsPath at runtime —
      // the non-literal filenames go through realpath + symlink + bounds checks.
      // keep the warnings as leads, not errors.
      'security/detect-non-literal-fs-filename': 'warn',
      'security/detect-object-injection': 'warn',
      // Electron main process uses `window`, `document`, `console` legitimately
      'no-undef': 'off',
    },
  },
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        HTMLElement: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        Image: 'readonly',
        matchMedia: 'readonly',
        getComputedStyle: 'readonly',
        requestIdleCallback: 'readonly',
        cancelIdleCallback: 'readonly',
        structuredClone: 'readonly',
        crypto: 'readonly',
        performance: 'readonly',
        screen: 'readonly',
        mediaDevices: 'readonly',
        AudioContext: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLImageElement: 'readonly',
        HTMLVideoElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLDialogElement: 'readonly',
        AbortController: 'readonly',
        IntersectionObserver: 'readonly',
        ClipboardItem: 'readonly',
        CSSStyleSheet: 'readonly',
        adoptedStyleSheets: 'readonly',
        mediaSession: 'readonly',
      },
    },
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'stream-assets/**',
      'src/lib/grok-orb/**',
      'src/mascot-lab/**',
      'docs/**',
      'tests/**',
      'tools/**',
      'scripts/**',
      'workbench/**',
      'public/**',
      'eval/**',
    ],
  },
]
