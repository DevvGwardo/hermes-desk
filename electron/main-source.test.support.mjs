import assert from 'node:assert/strict'
import ts from 'typescript'

const parse = source => ts.createSourceFile('main.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)

/** Bound structural pins to syntax, not a fixed byte budget or a comment. */
export function mainFunction(source, name) {
  const tree = parse(source)
  const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert(fn?.body, `Missing main function: ${name}`)
  return fn.body.getText(tree)
}

/** The isolated qualifier exits before ordinary live-app bootstrap. */
export function normalStartup(source) {
  const tree = parse(source)
  const ready = tree.statements.find(node => ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === 'app.whenReady().then')
  const body = ready?.expression.arguments[0]?.body
  assert(body && ts.isBlock(body), 'Missing main startup callback')
  const lock = body.statements[0]
  assert(lock && ts.isIfStatement(lock) && lock.expression.getText(tree) === '!gotLock' &&
    !lock.elseStatement && ts.isReturnStatement(lock.thenStatement) && !lock.thenStatement.expression,
  'Startup must first refuse a missing instance lock without live bootstrap')
  const guard = body.statements[1]
  assert(guard && ts.isIfStatement(guard) && guard.expression.getText(tree) === 'nativeQualification' &&
    !guard.elseStatement && ts.isBlock(guard.thenStatement), 'Missing isolated native startup guard')
  const statements = guard.thenStatement.statements
  assert.equal(statements.length, 2, 'Native startup must not bootstrap live app services')
  assert(ts.isExpressionStatement(statements[0]) && statements[0].expression.getText(tree) === 'createWindow()',
    'Native startup must create only the guarded window')
  assert(ts.isReturnStatement(statements[1]) && !statements[1].expression,
    'Native startup must exit before live app services')
  return body.statements.slice(2).map(node => node.getText(tree)).join('\n')
}

export function devModeExpression(source) {
  const tree = parse(source)
  const declaration = tree.statements.filter(ts.isVariableStatement)
    .flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(tree) === 'isDev')
  assert(declaration?.initializer, 'Missing development-origin policy')
  return declaration.initializer.getText(tree)
}
