#!/usr/bin/env node
// Fails when any @engram-mem/* dependency would resolve to a registry copy
// instead of the workspace package. An exact pin that the workspace version
// no longer satisfies makes npm install the published tarball nested under
// the dependent package, and that stale copy then runs silently in place of
// the local source.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCOPE = '@engram-mem'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(root, 'packages')

function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

// Supports the spec shapes used for internal deps; anything else is reported
// as unsupported rather than guessed at.
export function accepts(spec, version) {
  const v = parse(version)
  if (!v) return false
  const s = spec.trim().replace(/^workspace:/, '')
  if (s === '*' || s === '' || s === 'x') return true
  const op = /^(\^|~|>=)?\s*(.+)$/.exec(s)
  const base = parse(op[2])
  if (!base) return false
  const cmp = compare(v, base)
  switch (op[1]) {
    case undefined:
      return cmp === 0
    case '>=':
      return cmp >= 0
    case '~':
      return cmp >= 0 && v[0] === base[0] && v[1] === base[1]
    case '^':
      if (cmp < 0) return false
      if (base[0] > 0) return v[0] === base[0]
      if (base[1] > 0) return v[0] === 0 && v[1] === base[1]
      return v[0] === 0 && v[1] === 0 && v[2] === base[2]
    default:
      return false
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const pkgDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(packagesDir, d.name, 'package.json')))
  .map((d) => join(packagesDir, d.name))

const workspace = new Map()
for (const dir of pkgDirs) {
  const pkg = readJson(join(dir, 'package.json'))
  if (pkg.name?.startsWith(`${SCOPE}/`)) workspace.set(pkg.name, pkg.version)
}

const problems = []
for (const dir of pkgDirs) {
  const pkg = readJson(join(dir, 'package.json'))
  const nested = join(dir, 'node_modules', SCOPE)
  if (existsSync(nested)) {
    for (const name of readdirSync(nested)) {
      problems.push(`${pkg.name}: nested registry copy at ${join('packages', dir.split('/').pop(), 'node_modules', SCOPE, name)}`)
    }
  }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      const version = workspace.get(name)
      if (version === undefined) continue
      if (!accepts(spec, version)) {
        problems.push(`${pkg.name}: ${field}["${name}"] = "${spec}" does not accept workspace version ${version}`)
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`check-workspace-links: ${problems.length} problem(s)`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`check-workspace-links: ${workspace.size} ${SCOPE} packages, all resolved from the workspace`)
