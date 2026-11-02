// Test-only synthetic data. Assemble signatures in memory, never in committed HTML.
function jwt(header, payload, signature) {
  return [header, payload, signature].map((part) =>
    Buffer.from(part).toString('base64url')).join('.')
}

function pemBoundary(kind, label) {
  return ['-----', kind, ' ', label, '-----'].join('')
}

export function fakeToken(kind) {
  const prefixes = {
    openai: ['s', 'k-'],
    project: ['s', 'k-proj-'],
    github: ['g', 'hp_'],
    oauth: ['g', 'ho_'],
    pat: ['github', '_pat_'],
    aws: ['AK', 'IA'],
  }
  return prefixes[kind].join('') + (kind === 'aws' ? 'FAKEONLY00000000' :
    kind === 'project' || kind === 'pat' ? 'FAKE_fixture_only_1234567890' :
    'FAKEfixtureOnly1234567890')
}

export function fakeSlack(kind) {
  return ['xo', 'x', kind, '-', '000000000000', '-', 'FAKEFIXTUREONLY'].join('')
}

const keyLabel = ['PRIVATE', 'KEY'].join(' ')
const rsaLabel = ['RSA', keyLabel].join(' ')
const begin = ['BE', 'GIN'].join('')
const end = ['E', 'ND'].join('')
export const fixtures = {
  FAKE_PASSWORD_TYPE: ['pass', 'word'].join(''),
  FAKE_PASSWORD: ['FAKE', 'Login', 'Passphrase!73'].join('-'),
  FAKE_SIGNUP: ['FAKE', 'Signup', 'Passphrase!84'].join('-'),
  FAKE_CARD: ['4111', '1111', '1111', '1111'].join(' '),
  FAKE_OTHER_CARD: ['5555', '5555', '5555', '4444'].join('-'),
  FAKE_EXPIRY: ['12', '39'].join('/'),
  FAKE_CSC: ['8', '37'].join(''),
  FAKE_OTP: ['728', '194'].join(''),
  FAKE_NUMERIC_OTP: ['4961', '8327'].join(''),
  FAKE_TEXT_OTP: ['851', '642'].join(''),
  FAKE_REVERSE_OTP: ['318', '927'].join(''),
  FAKE_IBAN: ['FAKE', 'IBAN', 'DE00', '1234', '5678'].join('-'),
  FAKE_ROUTING: ['987', '654', '321'].join(''),
  FAKE_SSN: ['000', '12', '3456'].join('-'),
  FAKE_EDITABLE: ['FAKE', 'Editable', 'Routing', '184'].join('-'),
  FAKE_OPENAI: fakeToken('openai'),
  FAKE_GITHUB: fakeToken('github'),
  FAKE_OAUTH: fakeToken('oauth'),
  FAKE_PAT: fakeToken('pat'),
  FAKE_SLACK: fakeSlack('b'),
  FAKE_AWS: fakeToken('aws'),
  FAKE_JWT: jwt('{"alg":"HS256"}', '{"sub":"FAKE-FIXTURE"}', 'FAKE_SIGNATURE'),
  FAKE_UNSIGNED_JWT: jwt('{"alg":"none"}', 'FAKE_PAYLOAD', ''),
  FAKE_PEM_BEGIN: pemBoundary(begin, keyLabel),
  FAKE_PEM_END: pemBoundary(end, keyLabel),
  FAKE_RSA_BEGIN: pemBoundary(begin, rsaLabel),
  FAKE_RSA_END: pemBoundary(end, rsaLabel),
  FAKE_PEM_BODY: ['FAKE', 'PRIVATE', 'KEY', 'FIXTURE', 'NOT', 'VALID', 'BASE64'].join('-'),
  FAKE_SPLIT_BODY: ['FAKE', 'SPLIT', 'KEY', 'FIXTURE', 'NOT', 'VALID', 'BASE64'].join('-'),
}
fixtures.FAKE_PEM = [fixtures.FAKE_PEM_BEGIN, fixtures.FAKE_PEM_BODY, fixtures.FAKE_PEM_END].join('\n')
fixtures.FAKE_TRUNCATED_PEM = [fixtures.FAKE_RSA_BEGIN, 'FAKE-TRUNCATED-KEY'].join('\n')
Object.freeze(fixtures)

export function substituteFixtures(text, { json = false } = {}) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (_, name) => {
    if (!Object.hasOwn(fixtures, name)) throw new Error(`Unknown fixture placeholder: ${name}`)
    const value = fixtures[name]
    return json ? JSON.stringify(value).slice(1, -1) : value
  })
}
