import * as fs from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'
import * as v from 'vitest'
import ts from 'typescript'

/**
 * sr-names: every native control (button, input, textarea, select) in
 * src/components must expose an accessible name — via
 * aria-label, aria-labelledby, an associated label, or its own text
 * content. Icon-only buttons are the usual offender: sighted users get the
 * glyph, screen readers get silence.
 *
 * This is a static scan (TypeScript AST over source, no rendering) so it
 * covers every component file without needing to mount the app. It fails
 * listing the offending file:line and element.
 */

const ROOTS = ['src/components']
const TARGET_TAGS = new Set(['button', 'input', 'textarea', 'select'])

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry)
    if (fs.statSync(p).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      out.push(...listSourceFiles(p))
    } else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) {
      out.push(p)
    }
  }
  return out
}

// Collect the ids that labels point at in one file.
function collectLabelledIds(sf: ts.SourceFile): Set<string> {
  const ids = new Set<string>()
  const visit = (n: ts.Node): void => {
    if (ts.isJsxAttribute(n) && n.name.getText() === 'htmlFor' && n.initializer && ts.isStringLiteral(n.initializer)) {
      ids.add(n.initializer.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return ids
}

// True when the element (or any descendant) renders text: literal JSX text
// or an expression child (curly braces) that will render something.
// Whitespace-only text and JSX comments do not count.
function rendersText(node: ts.JsxElement | ts.JsxFragment): boolean {
  for (const child of node.children) {
    if (ts.isJsxText(child) && child.getText().trim() !== '') return true
    if (ts.isJsxExpression(child) && child.expression) return true
    if ((ts.isJsxElement(child) || ts.isJsxFragment(child)) && rendersText(child)) return true
  }
  return false
}

function attrOf(attrs: readonly ts.JsxAttributeLike[], name: string): ts.JsxAttribute | undefined {
  const a = attrs.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name)
  return a as ts.JsxAttribute | undefined
}

function strValue(a: ts.JsxAttribute | undefined): string | undefined {
  return a?.initializer && ts.isStringLiteral(a.initializer) ? a.initializer.text : undefined
}

// aria-label / aria-labelledby give a name (an empty string literal does not).
function hasAriaName(attrs: readonly ts.JsxAttributeLike[]): boolean {
  for (const name of ['aria-label', 'aria-labelledby']) {
    const a = attrOf(attrs, name)
    if (!a) continue
    if (!a.initializer) return true // bare attribute — still a name source
    if (ts.isStringLiteral(a.initializer) && a.initializer.text.trim() === '') continue
    return true
  }
  return false
}

function hasLabelAncestor(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent
  while (cur) {
    if (ts.isJsxElement(cur) && ts.isIdentifier(cur.openingElement.tagName) && cur.openingElement.tagName.text === 'label') return true
    cur = cur.parent
  }
  return false
}

function findViolations(sf: ts.SourceFile): string[] {
  const labelledIds = collectLabelledIds(sf)
  const violations: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const open = ts.isJsxElement(n) ? n.openingElement : n
      const tag = ts.isIdentifier(open.tagName) ? open.tagName.text : open.tagName.getText()
      if (TARGET_TAGS.has(tag)) {
        const attrs = open.attributes.properties
        const element = ts.isJsxElement(n) ? n : null
        const id = strValue(attrOf(attrs, 'id'))
        const type = strValue(attrOf(attrs, 'type'))
        const named =
          hasAriaName(attrs) ||
          // implicit label wrapping the control
          hasLabelAncestor(n) ||
          // explicit label htmlFor pointing at the control
          (id !== undefined && labelledIds.has(id)) ||
          // inputs named by their own type/value
          (tag === 'input' &&
            (type === 'hidden' ||
              ((type === 'submit' || type === 'reset' || type === 'button') && attrOf(attrs, 'value') !== undefined))) ||
          (element !== null && rendersText(element))
        if (!named) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
          violations.push(sf.fileName + ':' + line + ' <' + tag + '>')
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return violations
}

v.describe('accessible names on all controls (src/components)', () => {
  v.it('every button/input/textarea/select exposes an accessible name', () => {
    const here = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '../../..')
    const violations: string[] = []
    for (const root of ROOTS) {
      for (const file of listSourceFiles(path.join(here, root))) {
        const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
        violations.push(...findViolations(sf))
      }
    }
    v.expect(
      violations,
      String(violations.length) + ' control(s) without an accessible name:\n  ' + violations.join('\n  '),
    ).toEqual([])
  })
})
