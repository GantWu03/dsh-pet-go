/**
 * Architecture dependency rules, checked on parsed sources.
 *
 * The rules exist to keep the two deployable packages apart and to keep
 * platform APIs behind the modules that own them:
 *
 *   cross-package  a package may only reach another one through its package name
 *   shared-pure    shared/ holds wire contracts only: no platform packages
 *   adapters       host/src/adapters/* is imported from host/src/index.ts only
 *   electron       helper's Electron API lives in windows/desktop/capture modules
 *
 * Resolution uses the TypeScript compiler, not string matching, so re-exports,
 * side-effect imports and statically analysable `import()` / `require()` are all
 * seen, and aliases/paths resolve to real files.
 */
import ts from 'typescript'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Source extensions this project actually ships. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs'])
/** Generated or vendored directories never hold project sources. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'lib', 'dist', 'fixtures', 'coverage'])

/**
 * @param {string} root
 * @returns {string[]} absolute file paths
 */
function collectSources (root) {
  /** @type {string[]} */
  const files = []
  /** @param {string} directory */
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      if (SKIP_DIRECTORIES.has(entry)) continue
      const full = join(directory, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) files.push(full)
    }
  }
  const packages = join(root, 'packages')
  let names = []
  try {
    names = readdirSync(packages)
  } catch {
    return files
  }
  for (const name of names) {
    const directory = join(packages, name)
    if (!statSync(directory).isDirectory()) continue
    const src = join(directory, 'src')
    try {
      if (statSync(src).isDirectory()) walk(src)
    } catch {}
    // P0 keeps the pre-migration entry files next to the package manifest.
    for (const entry of readdirSync(directory)) {
      if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) files.push(join(directory, entry))
    }
  }
  return files
}

/**
 * @typedef {{ specifier: string, typeOnly: boolean }} ModuleReference
 */

/**
 * @param {string} file
 * @returns {ModuleReference[]} every module specifier the file mentions statically
 */
function specifiersOf (file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  )
  /** @type {ModuleReference[]} */
  const found = []
  /**
   * An import is type-only when the clause says so, or when every named binding
   * is marked `type` and there is no default/namespace import.
   * @param {ts.ImportDeclaration | ts.ExportDeclaration} node
   */
  const isTypeOnly = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      if (!clause) return false
      if (clause.isTypeOnly) return true
      if (clause.name) return false // a default import is a value
      const bindings = clause.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) return false
      return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)
    }
    if (node.isTypeOnly) return true
    const clause = node.exportClause
    if (!clause || !ts.isNamedExports(clause)) return false
    return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly)
  }
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        found.push({ specifier: node.moduleSpecifier.text, typeOnly: isTypeOnly(node) })
      }
    } else if (ts.isCallExpression(node)) {
      const argument = node.arguments[0]
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if ((isDynamicImport || isRequire) && argument && ts.isStringLiteralLike(argument)) {
        found.push({ specifier: argument.text, typeOnly: false })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/**
 * The `packages/<name>` a path belongs to, or null when it is outside packages/.
 * @param {string} file
 * @param {string} packagesRoot
 * @returns {{ packageName: string, rest: string } | null}
 */
function packageOf (file, packagesRoot) {
  const rel = relative(packagesRoot, file)
  if (rel.startsWith('..') || rel.includes(':')) return null
  const [name, ...rest] = rel.split(sep)
  return { packageName: name, rest: rest.join('/') }
}

/** Modules that own a platform capability inside the helper. */
const ELECTRON_OWNER_FILES = new Set(['windows.ts', 'desktop.ts', 'capture.ts'])
/** The helper's entry assembles the app lifecycle, so it may touch Electron too. */
const ELECTRON_ENTRY_SUFFIXES = ['/helper/main.js', '/helper/src/main/index.ts', '/helper/preload.cjs']

/**
 * @param {string} file absolute path
 * @returns {boolean}
 */
function ownsElectron (file) {
  const normalized = file.split(sep).join('/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (ELECTRON_OWNER_FILES.has(base)) return true
  return ELECTRON_ENTRY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

/**
 * @param {{ root: string }} options
 * @returns {{ file: string, rule: string, specifier: string, message: string }[]}
 */
export function checkDependencyRules ({ root }) {
  const packagesRoot = join(root, 'packages')
  const compilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    allowImportingTsExtensions: true,
    noEmit: true,
  }
  const violations = []
  for (const file of collectSources(root)) {
    const owner = packageOf(file, packagesRoot)
    if (!owner) continue
    for (const { specifier, typeOnly } of specifiersOf(file)) {
      const resolved = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys).resolvedModule
      const target = resolved ? packageOf(resolved.resolvedFileName, packagesRoot) : null
      const where = relative(root, file)
      if (owner.packageName === 'shared' && target && target.packageName !== 'shared') {
        violations.push({
          file: where,
          rule: 'shared-pure',
          specifier,
          message: 'shared 只放跨进程契约，不能引用平台包',
        })
      }
      if (target && target.packageName !== owner.packageName && !specifier.startsWith('@dsh-pet-go/')) {
        violations.push({
          file: where,
          rule: 'cross-package',
          specifier,
          message: `跨包引用必须走包名（目标是 packages/${target.packageName}）`,
        })
      }
      // Type-only imports of the adapter are the narrow interface it publishes;
      // only a value import means a module is reached into the DSH binding.
      if (!typeOnly && owner.packageName === 'host' && target?.packageName === 'host' && target.rest.includes('adapters/')) {
        const entry = file.split(sep).pop()
        if (entry !== 'index.ts') {
          violations.push({
            file: where,
            rule: 'adapters',
            specifier,
            message: 'DSH 适配器只在 host/src/index.ts 里装配，其他模块通过窄接口使用',
          })
        }
      }
      if (owner.packageName === 'helper' && specifier === 'electron' && !ownsElectron(file)) {
        violations.push({
          file: where,
          rule: 'electron',
          specifier,
          message: 'Electron API 只出现在 helper 的平台模块（windows/desktop/capture）和入口里',
        })
      }
    }
  }
  return violations
}
