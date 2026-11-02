'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto')
const { PROFILE_RE } = require('./tools.cjs')

const TOKEN_RE = /^[a-f0-9]{64}$/
const MAX_PROFILES = 200
const MAX_FILE_BYTES = 64 * 1024
const newToken = () => randomBytes(32).toString('hex')

/**
 * @param {string} directory
 */
function createProfileTokens(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Absolute MCP token directory required')
  const file = path.join(directory, 'profile-tokens.json')

  function checkDirectory() {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077)) throw new Error('Unsafe MCP token directory')
  }

  /**
   * @returns {Map<string, string>}
   */
  function read() {
    /** @type {number | undefined} */
    let fd
    try {
      checkDirectory()
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) ||
          stat.size > MAX_FILE_BYTES) throw new Error('Unsafe MCP token file')
      const data = JSON.parse(fs.readFileSync(fd, 'utf8'))
      if (data?.version !== 1 || !data.profiles || typeof data.profiles !== 'object' ||
          Array.isArray(data.profiles) || Object.keys(data.profiles).length > MAX_PROFILES ||
          Object.entries(data.profiles).some(([profile, token]) => !PROFILE_RE.test(profile) || !TOKEN_RE.test(token))) {
        throw new Error('Invalid MCP token file')
      }
      return new Map(Object.entries(data.profiles))
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return new Map()
      // Never include file contents or credentials in errors.
      throw new Error('MCP profile credentials unavailable')
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }

  /**
   * @param {unknown} profile
   * @param {unknown} token
   */
  function prepare(profile, token) {
    if (typeof profile !== 'string' || !PROFILE_RE.test(profile) ||
        (token !== null && (typeof token !== 'string' || !TOKEN_RE.test(token)))) {
      throw new Error('Invalid MCP profile credential')
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    checkDirectory()
    const profiles = read()
    if (token === null) profiles.delete(profile)
    else profiles.set(profile, token)
    if (profiles.size > MAX_PROFILES) throw new Error('Too many MCP profile credentials')
    const temporary = path.join(directory, `.profile-tokens-${randomUUID()}.tmp`)
    /** @type {number | undefined} */
    let fd
    try {
      fd = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(fd, `${JSON.stringify({ version: 1, profiles: Object.fromEntries(profiles) })}\n`)
      fs.fsyncSync(fd)
    } catch (error) {
      if (fd !== undefined) fs.unlinkSync(temporary)
      throw error
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
    return {
      commit() {
        checkDirectory()
        fs.renameSync(temporary, file)
      },
      dispose() {
        try { fs.unlinkSync(temporary) } catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
        }
      },
    }
  }

  /**
   * @param {unknown} profile
   * @param {unknown} token
   * @returns {boolean}
   */
  function verify(profile, token) {
    if (typeof profile !== 'string' || !PROFILE_RE.test(profile) ||
        typeof token !== 'string' || !TOKEN_RE.test(token)) return false
    try {
      const expected = read().get(profile)
      return !!expected && timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'))
    } catch { return false }
  }

  return { prepare, verify, file }
}

module.exports = { createProfileTokens, newToken, TOKEN_RE }
