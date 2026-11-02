// Real app + preload + main controller, disposable HOME/userData, fake inference.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { artifacts, launchHarness, repo, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const out = path.join(artifacts, `self-modification-${Date.now()}`)
await mkdir(out, { recursive: true })
const report = { checks: [], failure: null, pageErrors: [], modelRequests: null, workerRequests: 0 }
let h, modelServer, probeServer
process.once('SIGTERM', async () => { await h?.close(); process.exit(143) })

const sourceFiles = ['electron/main.cjs', 'electron/preload.cjs', 'electron/self-modification.cjs',
  'electron/self-modification-schema.cjs', 'electron/self-modification-workspace.cjs',
  'electron/self-modification-execution.cjs', 'electron/self-modification-runner.cjs', 'electron/self-modification-hermes.py',
  'electron/self-modification-validation.cjs', 'electron/self-modification-artifact.cjs',
  'electron/self-modification-build.cjs', 'electron/self-modification-build.py', 'electron/self-modification-preview.cjs',
  'electron/self-modification-authority.cjs', 'electron/self-modification-authority-worker.cjs',
  'electron/self-modification-seal.cjs', 'electron/self-modification-bound-build.cjs', 'electron/self-modification-native-inputs.cjs',
  'src/App.tsx', 'src/components/ImproveHermesDesk.tsx', 'src/components/SourcePreparation.tsx',
  'src/components/CandidateImplementation.tsx', 'src/components/CandidateValidation.tsx', 'scripts/install-local.mjs']
async function sourceDigests() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async file => [
    file, createHash('sha256').update(await readFile(path.join(repo, file))).digest('hex'),
  ])))
}
async function openJournal() {
  await h.page.getByRole('button', { name: 'Search', exact: true }).click()
  const search = h.page.getByRole('dialog', { name: 'Search', exact: true })
  await search.waitFor()
  await search.getByRole('combobox', { name: 'Search', exact: true }).fill('Improve Hermes Desk')
  await search.getByRole('option').filter({ hasText: 'Improve Hermes Desk' }).click()
  const dialog = h.page.getByRole('dialog', { name: 'Improve Hermes Desk', exact: true })
  await dialog.waitFor()
  await waitFor(async () => !/Reading saved|Saving to/.test(await dialog.getByRole('status').first().innerText()), 'change storage load')
  return dialog
}
async function journal() {
  return JSON.parse(await readFile(path.join(h.root, 'userData/self-modification/changes.json'), 'utf8'))
}
async function closeDialog(dialog) {
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
}

try {
  const before = await sourceDigests()
  h = await launchHarness()
  await h.page.emulateMedia({ reducedMotion: 'reduce' })
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  const welcome = h.page.getByRole('dialog', { name: 'Welcome to Hermes Desk', exact: true })
  if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Start using Hermes Desk', exact: true }).click()
  const guide = h.page.getByRole('button', { name: 'Got it', exact: true })
  if (await guide.isVisible()) await guide.click()
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).click()
  await h.page.getByRole('textbox', { name: 'Message the agent' }).waitFor()

  let dialog = await openJournal()
  assert.equal(await dialog.getByRole('status').innerText(), '0 saved requests')
  await dialog.getByRole('textbox', { name: 'Requested change', exact: true }).fill('Make saved-request search clearer')
  await dialog.getByRole('textbox', { name: 'Acceptance criteria', exact: true }).fill('A user can find and review the original request.')
  await dialog.getByRole('button', { name: 'Save request', exact: true }).click()
  await dialog.getByRole('heading', { name: 'Request recorded', exact: true }).waitFor()
  const first = await journal()
  assert.equal(first.revision, 1)
  assert.equal(first.changes.length, 1)
  assert.equal(first.changes[0].attempts[0].state, 'requested')
  assert(await dialog.getByText('Not started. This is a saved request, not an executing job.', { exact: true }).isVisible())
  assert.equal(await dialog.getByRole('button', { name: /approve|activate|install|run agent|preview/i }).count(), 0)
  report.checks.push('Command-palette entry, request form, native durable save and truthful detail')
  await h.page.screenshot({ path: path.join(out, 'request-detail.png') })

  await closeDialog(dialog)
  assert.equal(await h.page.getByRole('textbox', { name: 'Message the agent' }).count(), 1)
  dialog = await openJournal()
  await dialog.getByRole('heading', { name: 'Request recorded', exact: true }).waitFor()
  assert.deepEqual(await journal(), first)
  report.checks.push('Closing does not cancel; the working chat remains available and saved detail reopens')

  // A rejected stale operation cannot overwrite the current attempt.
  const stale = await h.page.evaluate(async () => {
    const current = await window.nubAgent.changes.list()
    const change = current.changes[0]
    return window.nubAgent.changes.cancel(0, change.id, change.attempts[0].id)
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'stale')
  assert.deepEqual(await journal(), first)
  report.checks.push('Real preload rejects stale revision without changing the journal')

  await dialog.getByRole('button', { name: 'Cancel request', exact: true }).click()
  await dialog.getByRole('heading', { name: 'Cancelled request', exact: true }).waitFor()
  const cancelled = await journal()
  assert.equal(cancelled.revision, 2)
  assert.equal(cancelled.changes[0].cancellationEpoch, 1)
  assert.equal(cancelled.changes[0].attempts[0].state, 'cancelled')
  await closeDialog(dialog)
  await h.restartApp({ newOrigin: true })
  dialog = await openJournal()
  await dialog.getByRole('heading', { name: 'Cancelled request', exact: true }).waitFor()
  assert.deepEqual(await journal(), cancelled)
  report.checks.push('Cancellation survives a complete Electron/backend restart and changed renderer origin')

  await dialog.getByRole('button', { name: 'Reopen request', exact: true }).click()
  await dialog.getByText('Attempt 2', { exact: true }).waitFor()
  const reopened = await journal()
  const change = reopened.changes[0]
  assert.equal(reopened.revision, 3)
  assert.equal(change.cancellationEpoch, 2)
  assert.deepEqual(change.attempts[0], cancelled.changes[0].attempts[0])
  assert.notEqual(change.attempts[1].id, change.attempts[0].id)
  assert.equal(change.attempts[1].state, 'requested')
  await dialog.getByText('Record and attempt history', { exact: true }).click()
  assert(await dialog.getByText('Attempt 1: cancelled', { exact: true }).isVisible())
  report.checks.push('Explicit reopen creates a distinct attempt and retains cancelled history')

  await closeDialog(dialog)
  await h.restartApp({ newOrigin: true })
  dialog = await openJournal()
  await dialog.getByText('Attempt 2', { exact: true }).waitFor()
  assert.deepEqual(await journal(), reopened)
  report.checks.push('Reopened attempt recovers on another complete restart')

  // Create a source repository entirely inside this disposable HOME. Plumbing
  // uses the configured identity and never touches the live checkout's index.
  const sourceRoot = path.join(h.root, 'fixture-source')
  await mkdir(sourceRoot)
  const git = (args, input) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', sourceRoot, ...args],
    { input, encoding: 'utf8' }).trim()
  git(['init', '-q'])
  const fixtureInputs = {
    'src/components/FixtureNote.tsx': 'export const fixtureNote = "baseline native fixture";\n',
    'package.json': JSON.stringify({ name: 'hermes-desk', type: 'module', main: 'electron/main.cjs',
      scripts: { build: 'throw Error("baseline package scripts must not run")' } }),
    'index.html': '<h1 id="fixture-preview">Not loaded</h1><script type="module" src="./src/preview.ts"></script>',
    'src/preview.ts': 'import { fixtureNote } from "./components/FixtureNote"; document.querySelector("#fixture-preview")!.textContent = "Isolated native renderer"; document.body.dataset.fixtureNote = fixtureNote;',
    'vite.config.mjs': 'throw Error("baseline Vite configuration must not run")',
    'postcss.config.cjs': 'throw Error("baseline PostCSS configuration must not run")',
    'babel.config.cjs': 'throw Error("baseline Babel configuration must not run")',
    'electron/main.cjs': await readFile(path.join(repo, 'electron/main.cjs'), 'utf8'),
    'electron/preload.cjs': await readFile(path.join(repo, 'electron/preload.cjs'), 'utf8'),
  }
  // Protected bootstrap bytes are deliberate fixture inputs, never model proposals.
  for (const [name,content] of Object.entries(fixtureInputs)) {
    await mkdir(path.dirname(path.join(sourceRoot,name)),{recursive:true})
    await writeFile(path.join(sourceRoot,name),content)
  }
  git(['add','--',...Object.keys(fixtureInputs)])
  const head = git(['commit-tree',git(['write-tree']),'-m','Disposable native source baseline'])
  git(['update-ref', 'HEAD', head])
  git(['read-tree', 'HEAD'])
  await writeFile(path.join(sourceRoot, 'src/components/FixtureNote.tsx'), 'export const fixtureNote = "dirty source must remain";\n')
  await writeFile(path.join(sourceRoot, 'untracked.txt'), 'untracked source must remain\n')
  await h.app.evaluate(({ dialog }, root) => {
    // Fixture native picker response, not an arbitrary renderer path parameter.
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
    dialog.showMessageBox = async (_parent, input) => ({ response: input.title === 'Independent exact source-baseline review' ? 1 : 0 })
  }, sourceRoot)
  await dialog.getByRole('button', { name: 'Choose source repository', exact: true }).click()
  const prepare = dialog.getByRole('button', { name: 'Prepare isolated source', exact: true })
  await prepare.waitFor()
  assert.equal(await prepare.isEnabled(), false, 'HEAD baseline must not be pre-authorized')
  assert(await dialog.getByText('2 dirty/untracked entries will be excluded and preserved in the original checkout.', { exact: true }).isVisible())
  await dialog.getByRole('checkbox', { name: 'Use committed HEAD only. I understand this excludes all uncommitted and untracked work.', exact: true }).check()
  await prepare.click()
  await dialog.getByRole('heading', { name: 'Source prepared', exact: true }).waitFor()
  const prepared = await journal()
  const prep = prepared.changes[0].attempts.at(-1).preparation
  assert.equal(prepared.version, 7)
  assert.equal(prep.source.head, head)
  assert.equal(prep.fileCount, 9)
  const candidate = path.join(h.root, 'userData/self-modification/workspaces', prep.workspace.id, 'source')
  assert.equal(await readFile(path.join(candidate, 'src/components/FixtureNote.tsx'), 'utf8'), 'export const fixtureNote = "baseline native fixture";\n')
  assert.equal(await readFile(path.join(sourceRoot, 'src/components/FixtureNote.tsx'), 'utf8'), 'export const fixtureNote = "dirty source must remain";\n')
  assert.equal(await readFile(path.join(sourceRoot, 'untracked.txt'), 'utf8'), 'untracked source must remain\n')
  report.checks.push('Explicit native-selected committed HEAD materializes an owned source copy and excludes/preserves dirty work')

  await writeFile(path.join(candidate, 'src/components/FixtureNote.tsx'), 'export const fixtureNote = "inert candidate proposal";\n')
  await dialog.getByRole('button', { name: 'Review candidate files and diffs', exact: true }).click()
  await dialog.getByText('1 changed files · 9 files reviewed', { exact: true }).waitFor()
  await dialog.getByText('src/components/FixtureNote.tsx · modified', { exact: true }).click()
  assert((await dialog.locator('pre').innerText()).includes('-export const fixtureNote = "baseline native fixture";'))
  assert((await dialog.locator('pre').innerText()).includes('+export const fixtureNote = "inert candidate proposal";'))
  report.checks.push('Real candidate file mutation displays exact before/after digests and an inert text diff')
  await h.page.screenshot({ path: path.join(out, 'source-review.png') })
  await closeDialog(dialog)
  await h.restartApp({ newOrigin: true })
  dialog = await openJournal()
  await dialog.getByRole('heading', { name: 'Source prepared', exact: true }).waitFor()
  assert.deepEqual(await journal(), prepared)
  await dialog.getByRole('button', { name: 'Review candidate files and diffs', exact: true }).click()
  await dialog.getByText('1 changed files · 9 files reviewed', { exact: true }).waitFor()
  report.checks.push('Prepared workspace ownership and real diffs recover after complete native restart')

  // An additional owned fake model endpoint, not the live chat/agent backend.
  modelServer = http.createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    assert.equal(body.model, 'fixture-worker')
    assert.deepEqual(body.tools, [])
    assert.equal(body.tool_choice, 'none')
    assert(raw.includes('A user can find and review the original request.'))
    assert(raw.includes('inert candidate proposal'))
    report.workerRequests++
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ id: 'fixture-worker', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant',
        content: JSON.stringify({ changes: [
          { op: 'write', path: 'src/components/FixtureNote.tsx', content: 'export const fixtureNote = "Hermes native candidate edit";\n' },
        ] }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }))
  })
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve))
  const runtime = { source: h.source, python: await realpath(h.python),
    environment: h.runtimeKind === 'managed' ? path.dirname(path.dirname(h.python)) : null,
    readRoots: [h.source, path.dirname(path.dirname(await realpath(h.python))),
      path.dirname(path.dirname(h.python)), path.join(h.root, 'runtime')] }
  await h.app.evaluate(({ dialog }, { module, runtime }) => {
    process.getBuiltinModule('module').createRequire(module)(module).discoverRuntime = () => runtime
    dialog.showMessageBox = async () => ({ response: 1 })
  }, { module: path.join(repo, 'electron/self-modification-runner.cjs'), runtime })
  await dialog.getByLabel('Local model port', { exact: true }).fill(String(modelServer.address().port))
  await dialog.getByLabel('Model name', { exact: true }).fill('fixture-worker')
  await dialog.getByRole('button', { name: 'Choose candidate context files', exact: true }).click()
  await dialog.getByRole('checkbox', { name: 'src/components/FixtureNote.tsx', exact: true }).check()
  const implement = dialog.getByRole('button', { name: 'Request candidate implementation', exact: true })
  await implement.click()
  await waitFor(async () => !/Saving to/.test(await dialog.getByRole('status').innerText()), 'declined inference confirmation')
  assert.deepEqual(await journal(), prepared)
  assert.equal(report.workerRequests, 0)
  report.checks.push('Native inference refusal preserves journal/candidate and makes zero model requests')
  await h.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }) })
  await implement.click()
  await dialog.getByRole('heading', { name: 'Candidate edits recorded', exact: true }).waitFor({ timeout: 45000 })
  const implemented = await journal()
  const execution = implemented.changes[0].attempts.at(-1).execution
  assert.equal(execution.stage, 'implemented')
  assert.equal(execution.calls, 1)
  assert.equal(report.workerRequests, 1)
  assert.equal(await readFile(path.join(candidate, 'src/components/FixtureNote.tsx'), 'utf8'), 'export const fixtureNote = "Hermes native candidate edit";\n')
  assert.equal(await readFile(path.join(sourceRoot, 'src/components/FixtureNote.tsx'), 'utf8'), 'export const fixtureNote = "dirty source must remain";\n')
  assert.equal(await readFile(path.join(sourceRoot, 'untracked.txt'), 'utf8'), 'untracked source must remain\n')
  await dialog.getByRole('button', { name: 'Review candidate files and diffs', exact: true }).click()
  await dialog.getByText('src/components/FixtureNote.tsx · modified', { exact: true }).click()
  assert((await dialog.locator('pre').filter({ hasText: '--- a/src/components/FixtureNote.tsx' }).innerText()).includes('+export const fixtureNote = "Hermes native candidate edit";'))
  assert(await dialog.getByText('Candidate edits recorded. Not tested, previewed, approved or activated.', { exact: true }).isVisible())
  await h.page.screenshot({ path: path.join(out, 'candidate-implementation.png') })
  report.checks.push('Real isolated Hermes/preload/controller applies only the candidate and shows a truthful real diff')
  await closeDialog(dialog)
  await h.restartApp({ newOrigin: true })
  dialog = await openJournal()
  await dialog.getByRole('heading', { name: 'Candidate edits recorded', exact: true }).waitFor()
  assert.deepEqual(await journal(), implemented)
  assert.equal(await dialog.getByRole('button', { name: 'Request candidate implementation', exact: true }).count(), 0)
  report.checks.push('Implemented state, exact attempt evidence and candidate edit survive complete native restart without rerunning inference')

  // These permissions apply only to this disposable fixture and its generated
  // renderer. They are not user consent to validate/install a live candidate.
  await h.app.evaluate(({ dialog }, { module, runtime, nodeDirectory }) => {
    process.getBuiltinModule('module').createRequire(module)(module).discoverRuntime = () => runtime
    process.env.PATH = `${nodeDirectory}:${process.env.PATH}`
    dialog.showMessageBox = async () => ({ response: 0 })
  }, { module: path.join(repo, 'electron/self-modification-runner.cjs'), runtime,
    nodeDirectory: path.dirname(fs.realpathSync(process.execPath)) })
  const validate = dialog.getByRole('button', { name: 'Run scoped renderer checks', exact: true })
  await validate.click()
  await waitFor(async () => !/Saving to/.test(await dialog.getByRole('status').first().innerText()), 'declined renderer check confirmation')
  assert.deepEqual(await journal(), implemented)
  await h.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }) })
  await validate.click()
  await dialog.getByRole('heading', { name: 'Renderer scope checked', exact: true }).waitFor({ timeout: 60000 })
  const rendererChecked = await journal()
  const validation = rendererChecked.changes[0].attempts.at(-1).validation
  assert.equal(validation.scope, 'renderer-only')
  assert.equal(validation.checksPassed, true)
  assert.equal(validation.artifact.activationEligible, false)
  assert.equal(validation.preview, null)
  assert.equal(report.workerRequests, 1)
  report.checks.push('Explicit fixture consent runs real fixed sandboxed type/syntax/build checks; immutable renderer identity is activation-ineligible')
  await h.page.screenshot({ path: path.join(out, 'renderer-checks.png') })

  await h.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }) })
  const contracts = dialog.getByRole('button', { name: 'Run isolated authority contracts', exact: true })
  await contracts.click()
  await waitFor(async () => !/Saving to/.test(await dialog.getByRole('status').first().innerText()), 'declined authority contracts')
  assert.deepEqual(await journal(), rendererChecked)
  await h.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }) })
  await contracts.click()
  await waitFor(async () => (await journal()).changes[0].attempts.at(-1).validation.authority?.stage === 'passed', 'isolated authority contracts')
  await dialog.getByText('6 independent fixture contracts passed.', { exact: true }).waitFor()
  const contractsChecked = await journal()
  const contractRecord = contractsChecked.changes[0].attempts.at(-1).validation.authority
  assert.equal(contractRecord.sourceDigest, validation.sourceDigest)
  assert.equal(contractRecord.rendererDigest, validation.artifact.digest)
  assert.equal(contractRecord.nativeBehaviorVerified, false)
  assert.equal(contractRecord.fullAppQualified, false)
  assert.equal(report.workerRequests, 1)
  await h.page.screenshot({ path: path.join(out, 'authority-contracts.png') })
  report.checks.push('Separate explicit fixture consent runs real no-fork kernel-isolated candidate main/preload adapters; parent evaluates six contracts and records scoped observations, never native/full-app qualification')

  const consentMarker = path.join(h.root, 'seal-refused.json')
  await h.app.evaluate(({ dialog }, marker) => {
    const fs = process.getBuiltinModule('node:fs')
    dialog.showMessageBox = async () => { fs.writeFileSync(marker, '{"refused":true}'); return { response: 0 } }
  }, consentMarker)
  await h.app.evaluate((_electron, file) => {
    const load = process.getBuiltinModule('node:module').createRequire(file)
    const seal = load(file), original = seal.provenance
    seal.provenance = async (...args) => {
      try { return await original(...args) } catch (error) { console.error('[owned seal diagnostic]', error.stack); throw error }
    }
  }, path.join(repo, 'electron/self-modification-seal.cjs'))
  const sealButton = dialog.getByRole('button', { name: 'Seal full app inputs', exact: true })
  await sealButton.click()
  await waitFor(async () => {
    const alerts = await dialog.getByRole('alert').allTextContents()
    if (alerts.length) throw new Error('Seal was refused before confirmation: ' + alerts.join('; '))
    return fs.existsSync(consentMarker)
  }, 'actual seal refusal reached', 90000)
  await waitFor(async () => sealButton.isEnabled(), 'declined full seal finished', 60000)
  assert.deepEqual(await journal(), contractsChecked)
  await h.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }) })
  await sealButton.click()
  await waitFor(async () => {
    const seal = (await journal()).changes[0].attempts.at(-1).validation.seal
    if (seal?.stage === 'failed') throw Error('Full app-input seal failed: ' + seal.error)
    return seal?.stage === 'sealed'
  }, 'full app-input seal', 180000)
  await dialog.getByText('Full app-input identity recorded. Native qualification remains incomplete.', { exact: true }).waitFor()
  let checked = await journal()
  const sealRecord = checked.changes[0].attempts.at(-1).validation.seal
  assert.equal(sealRecord.fullAppQualified, false)
  assert.equal(sealRecord.artifact.activationEligible, false)
  report.seal = { entries: sealRecord.artifact.entries, bytes: sealRecord.artifact.bytes,
    dependencyDigest: sealRecord.dependencyDigest, scope: sealRecord.scope, activationEligible: false }
  const sealFolder = path.join(h.root, 'userData/self-modification', `seal-${sealRecord.operationId}`, 'artifact')
  assert.equal(await readFile(path.join(sealFolder, 'app/electron/main.cjs'), 'utf8'), await readFile(path.join(repo, 'electron/main.cjs'), 'utf8'))
  assert.equal(await readFile(path.join(sealFolder, 'app/dist/index.html'), 'utf8'),
    await readFile(path.join(h.root, 'userData/self-modification', `check-${validation.operationId}`, 'artifact/index.html'), 'utf8'))
  const archive = 'node_modules/electron/dist/Electron.app/Contents/Resources/default_app.asar'
  assert.equal(createHash('sha256').update(await readFile(path.join(sealFolder, 'app', archive))).digest('hex'),
    createHash('sha256').update(await readFile(path.join(repo, archive))).digest('hex'), 'Physical ASAR bytes, not a virtual archive view')
  assert.equal(report.workerRequests, 1)
  await h.page.screenshot({ path: path.join(out, 'full-app-inputs.png') })
  report.checks.push('Separate refused/accepted fixture consent seals all main/preload/source/renderer and the complete provisioned dependency graph into one activation-ineligible identity without executing hooks or modifying the originals')

  const boundRefusal = path.join(h.root, 'bound-refused.json')
  await h.app.evaluate(({ dialog }, marker) => {
    const fs = process.getBuiltinModule('node:fs')
    dialog.showMessageBox = async () => { fs.writeFileSync(marker, '{"refused":true}'); return { response: 0 } }
  }, boundRefusal)
  const boundButton = dialog.getByRole('button', { name: 'Build against sealed dependencies', exact: true })
  await boundButton.click()
  await waitFor(async () => {
    const errors = await dialog.getByRole('alert').allTextContents()
    if (errors.length) throw Error('Bound inspection failed: ' + errors.join('; '))
    return fs.existsSync(boundRefusal)
  }, 'bound consent actually refused', 120000)
  await waitFor(async () => boundButton.isEnabled(), 'bound refusal completed', 60000)
  assert.deepEqual(await journal(), checked)
  await h.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }) })
  await boundButton.click()
  await waitFor(async () => {
    const attempt = (await journal()).changes[0].attempts.at(-1)
    if (attempt.state === 'failed') throw Error('Bound native checks failed: ' + attempt.validation.boundBuild?.error)
    return attempt.validation.boundBuild?.stage === 'passed'
  }, 'actual frozen graph renderer build', 300000)
  await dialog.getByText('New renderer output is bound to the sealed source and dependency graph.', { exact: true }).waitFor()
  checked = await journal()
  const boundRecord = checked.changes[0].attempts.at(-1).validation.boundBuild
  assert.equal(boundRecord.inputDigest, sealRecord.artifact.digest)
  assert.equal(boundRecord.dependencyDigest, sealRecord.dependencyDigest)
  assert.equal(boundRecord.fullAppQualified, false)
  assert.equal(boundRecord.artifact.activationEligible, false)
  report.boundBuild = { scope: boundRecord.scope, inputDigest: boundRecord.inputDigest,
    dependencyDigest: boundRecord.dependencyDigest, toolchainDigest: boundRecord.toolchainDigest,
    rendererDigest: boundRecord.artifact.rendererDigest, boundDigest: boundRecord.artifact.boundDigest,
    fullAppQualified: false, activationEligible: false }
  await h.page.screenshot({ path: path.join(out, 'bound-renderer-build.png') })
  report.checks.push('Real separate refused/accepted native consent executes fixed renderer checks against full sealed graph and acknowledges exact input/source/dependency/policy/new-output binding, never native qualification')

  const qualification = dialog.getByRole('button', { name: 'Qualify disposable native renderer', exact: true })
  assert.equal(await qualification.isEnabled(), false, 'Unknown retained delivery state must not permit a new qualification')
  await dialog.getByRole('button', { name: 'Reload delivery records', exact: true }).click()
  await dialog.getByText('Native delivery authority is unavailable. Retained records are read-only; no qualification or activation is available.', { exact: true }).waitFor()
  assert.equal(await qualification.isEnabled(), false, 'A phase-two-disabled host must remain read-only after explicit reconciliation')
  const delivery = await h.page.evaluate(async change => window.nubAgent.changes.deliveryStatus(change.id, change.attempts.at(-1).id),
    checked.changes[0])
  assert.equal(delivery.ok, true)
  assert.equal(delivery.authorityAvailable, false)
  assert.equal(delivery.historicalReadOnly, true)
  assert.deepEqual(delivery.records, [])
  assert.deepEqual(await journal(), checked)
  report.checks.push('Actual main/preload delivery status keeps native controls default-deny before reconciliation and read-only afterward while phase two is closed; no qualification intent or source-journal mutation')

  await dialog.getByRole('button', { name: 'Inspect native inputs', exact: true }).click()
  await dialog.getByText(/missing literal native input paths observed/).waitFor({ timeout: 120000 })
  const nativeDiagnostics = await dialog.getByText(/missing literal native input paths observed/).innerText()
  assert(!nativeDiagnostics.startsWith('0 '), 'The fixture main is missing real required helpers')
  await dialog.getByText('electron/stt-local.cjs', { exact: true }).waitFor()
  assert(await dialog.getByText(/Zero missing paths does not mean a runnable or safe app/).isVisible())
  assert.deepEqual(await journal(), checked)
  report.nativeInputDiagnostics = nativeDiagnostics
  await h.page.screenshot({ path: path.join(out, 'native-input-diagnostics.png') })
  report.checks.push('Real bounded native-input IPC independently verifies exact bound inputs, visibly finds missing main helpers, makes no journal writes and explicitly refuses to equate lexical diagnostics with native execution or qualification')

  const previewRefusal = path.join(h.root, 'preview-refused.json')
  await h.app.evaluate(({ dialog }, marker) => {
    const fs = process.getBuiltinModule('node:fs')
    dialog.showMessageBox = async () => { fs.writeFileSync(marker, '{"refused":true}'); return { response: 0 } }
  }, previewRefusal)
  await dialog.getByRole('button', { name: 'Open isolated renderer preview', exact: true }).click()
  await waitFor(async () => fs.existsSync(previewRefusal), 'actual preview refusal reached', 60000)
  await waitFor(async () => dialog.getByRole('button', { name: 'Open isolated renderer preview', exact: true }).isEnabled(), 'declined preview finished', 60000)
  assert.deepEqual(await journal(), checked)
  assert.equal(h.app.windows().filter(page => page.url().startsWith('hd-candidate://')).length, 0)
  await h.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }) })
  await dialog.getByRole('button', { name: 'Open isolated renderer preview', exact: true }).click()
  await waitFor(async () => (await journal()).changes[0].attempts.at(-1).validation.preview?.state === 'open', 'isolated preview checkpoint')
  const preview = h.app.windows().find(page => page.url().startsWith('hd-candidate://'))
  assert(preview)
  await preview.getByRole('heading', { name: 'Isolated native renderer', exact: true }).waitFor()
  assert.deepEqual(await preview.evaluate(() => ({ bridge: typeof window.nubAgent, node: typeof window.require })),
    { bridge: 'undefined', node: 'undefined' })
  let networkRequests = 0
  probeServer = http.createServer((_request, response) => { networkRequests++; response.end('owned probe') })
  await new Promise(resolve => probeServer.listen(0, '127.0.0.1', resolve))
  const network = await preview.evaluate(async url => {
    let blocked = false
    try { await fetch(url) } catch { blocked = true }
    const child = window.open(url)
    return { blocked, popup: child === null }
  }, `http://127.0.0.1:${probeServer.address().port}/owned-probe`)
  assert.deepEqual(network, { blocked: true, popup: true })
  assert.equal(networkRequests, 0)
  assert.equal((await journal()).changes[0].attempts.at(-1).validation.preview.behaviorVerified, false)
  assert.equal((await journal()).changes[0].attempts.at(-1).validation.preview.artifactDigest, boundRecord.artifact.rendererDigest)
  await preview.screenshot({ path: path.join(out, 'isolated-renderer.png') })
  report.checks.push('Real separate sandboxed Chromium display runs sealed candidate pixels with no bridge/Node, zero probe network/popup, and no claimed behavior/health')
  await h.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('hd-candidate://')).destroy()
  })
  await dialog.getByRole('button', { name: 'Reload requests', exact: true }).click()
  await waitFor(async () => (await journal()).changes[0].attempts.at(-1).validation.preview.state === 'closed', 'preview closed checkpoint')
  assert.equal((await journal()).changes[0].attempts.at(-1).state, 'checked')
  await dialog.getByRole('button', { name: 'Open isolated renderer preview', exact: true }).click()
  await waitFor(async () => (await journal()).changes[0].attempts.at(-1).validation.preview.state === 'open', 'second explicit preview')
  await closeDialog(dialog)
  await h.app.evaluate((_electron, ownedJournal) => {
    const fs = process.getBuiltinModule('fs'), rename = fs.renameSync
    fs.renameSync = (from, to) => {
      if (to === ownedJournal && JSON.parse(fs.readFileSync(from, 'utf8')).changes[0].attempts.at(-1).validation?.preview?.state === 'closed')
        throw new Error('Disposable fixture: closing acknowledgment lost')
      return rename(from, to)
    }
  }, path.join(h.root, 'userData/self-modification/changes.json'))
  await h.restartApp({ newOrigin: true })
  dialog = await openJournal()
  await dialog.getByRole('heading', { name: 'Renderer scope checked', exact: true }).waitFor()
  const recovered = await journal()
  assert.equal(recovered.changes[0].attempts.at(-1).validation.preview.state, 'interrupted')
  assert.equal(recovered.changes[0].attempts.at(-1).validation.artifact.digest, validation.artifact.digest)
  assert.deepEqual(recovered.changes[0].attempts.at(-1).validation.authority, contractRecord)
  assert.deepEqual(recovered.changes[0].attempts.at(-1).validation.seal, sealRecord)
  assert.deepEqual(recovered.changes[0].attempts.at(-1).validation.boundBuild, boundRecord)
  const verify = dialog.getByRole('button', { name: 'Verify sealed app inputs', exact: true })
  await verify.click()
  await dialog.getByRole('status').first().filter({ hasText: 'Saving to' }).waitFor()
  await waitFor(async () => !/Saving to/.test(await dialog.getByRole('status').first().innerText()), 'restart full seal verification', 60000)
  assert.deepEqual(await journal(), recovered)
  await dialog.getByRole('button', { name: 'Verify bound renderer build', exact: true }).click()
  await waitFor(async () => !/Saving to/.test(await dialog.getByRole('status').first().innerText()), 'restart bound renderer verification', 120000)
  assert.deepEqual(await journal(), recovered)
  assert.equal(report.workerRequests, 1)
  report.checks.push('Full app-input seal survives a complete native restart and verifies exact copied evidence without rebuilding, rerunning contracts or inference')
  report.checks.push('Bound renderer build survives complete native restart, verifies exact graph/output without rerunning compilers and supplies the actual isolated display bytes')
  assert.equal(h.app.windows().filter(page => page.url().startsWith('hd-candidate://')).length, 0)
  assert.equal(report.workerRequests, 1)
  report.checks.push('Display closes independently; injected lost close acknowledgment plus complete app restart retains sealed evidence, marks old display interrupted and never auto-reopens/rebuilds/infers')

  await h.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }) })
  await dialog.getByRole('button', { name: 'Open isolated renderer preview', exact: true }).click()
  await waitFor(async () => (await journal()).changes[0].attempts.at(-1).validation.preview.state === 'open', 'recovered explicit display')
  await dialog.getByRole('button', { name: 'Cancel request', exact: true }).click()
  await dialog.getByRole('heading', { name: 'Cancelled request', exact: true }).waitFor()
  const previewCancelled = await journal()
  assert.equal(previewCancelled.changes[0].attempts.at(-1).validation.preview.state, 'closed')
  assert.equal(previewCancelled.changes[0].cancellationEpoch, 3)
  assert.equal(h.app.windows().filter(page => page.url().startsWith('hd-candidate://')).length, 0)
  assert.equal(previewCancelled.changes[0].attempts.at(-1).validation.artifact.digest, validation.artifact.digest)
  report.checks.push('Real primary-frame cancellation closes only the owned native preview, retains evidence and never resurrects the cancelled attempt')

  // Corrupt only the disposable fixture journal. The UI must not repair/reset it.
  const file = path.join(h.root, 'userData/self-modification/changes.json')
  await writeFile(file, '{"version":999,"unapproved":"do not reset"}')
  await dialog.getByRole('button', { name: 'Reload requests', exact: true }).click()
  await dialog.getByRole('alert').waitFor()
  assert.equal(await dialog.getByRole('button', { name: 'Reopen request', exact: true }).isEnabled(), false)
  assert.equal(await readFile(file, 'utf8'), '{"version":999,"unapproved":"do not reset"}')
  const rejected = await h.page.evaluate(async () => window.nubAgent.changes.create(3, {
    request: 'Must not overwrite corrupt data', acceptanceCriteria: 'Preserve bytes',
  }))
  assert.equal(rejected.ok, false)
  assert.equal(await readFile(file, 'utf8'), '{"version":999,"unapproved":"do not reset"}')
  report.checks.push('Malformed journal visibly blocks mutations and retains exact recoverable bytes')

  report.modelRequests = h.model.requests.length
  assert.equal(report.modelRequests, 0, 'The live-chat fixture backend must not receive inference')
  const rpc = await h.app.evaluate(() => globalThis.__hermesDeskE2ERpc)
  assert.equal(rpc.filter(item => ['chat', 'session.chat', 'session.send', 'approval.response'].includes(item.method)).length, 0)
  assert.deepEqual(await sourceDigests(), before, 'Request lifecycle must not change source or installer')
  assert.deepEqual(h.consoleErrors, [])
  report.checks.push('One explicit worker fake request only, zero live-chat/approval submissions, unchanged source and installer, no renderer errors')
} catch (error) {
  report.failure = error.stack
  if (h) {
    report.ownedNativeLogs = h.logs.slice(-15)
    try { report.ownedUIErrors = await h.page.getByRole('alert').allTextContents() } catch { /* Closed fixture page. */ }
    try {
      report.ownedFailureJournal = JSON.parse(JSON.stringify(await journal(), (key, value) => key === 'token' ? '[fixture ownership marker omitted]' : value))
      const failedSeal = report.ownedFailureJournal.changes[0].attempts.at(-1).validation?.seal
      if (failedSeal) {
        const folder = path.join(h.root, 'userData/self-modification', `seal-${failedSeal.operationId}`, 'artifact')
        let regularFiles = 0, copiedBytes = 0
        const walk = name => {
          for (const entry of fs.readdirSync(name, { withFileTypes: true })) {
            const target = path.join(name, entry.name)
            if (entry.isDirectory()) walk(target)
            else if (entry.isFile()) { regularFiles++; copiedBytes += fs.lstatSync(target).size }
          }
        }
        if (fs.existsSync(folder)) walk(folder)
        report.ownedSealProgress = { regularFiles, copiedBytes, declarationPresent: fs.existsSync(path.join(folder, 'provenance.json')) }
      }
    } catch { /* Disposable fixture may not have reached journal creation. */ }
  }
  process.exitCode = 1
} finally {
  report.pageErrors = h?.consoleErrors ?? []
  if (modelServer) {
    modelServer.closeAllConnections()
    await new Promise(resolve => modelServer.close(resolve))
  }
  if (probeServer) {
    probeServer.closeAllConnections()
    await new Promise(resolve => probeServer.close(resolve))
  }
  if (h) await h.close()
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, evidence: out }, null, 2))
}
