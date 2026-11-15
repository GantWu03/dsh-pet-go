/**
 * Assemble the distributable: one directory that Plugin Manager can install and
 * that contains everything the plugin needs at runtime.
 *
 *   release/dsh-pet-go-<version>/
 *     package.json          bundle manifest (exports, dsh.bundle.patch)
 *     lib/index.js          built host entry
 *     helper/               built Electron app directory
 *     cordis.patch.yml      the row the bundle inserts
 *     locale/*.json         display metadata
 *     icon.svg              plugin icon
 *     README.md/LICENSE/NOTICE.md
 *
 * The script then proves the thing it just wrote: the entry imports and exports
 * the plugin shape, the installed layout resolves its helper, and no sources,
 * tests or source maps slipped in. A package that fails these checks is worse
 * than no package, because installation would look successful.
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOST_DIR = join(ROOT, 'packages', 'host')
const HELPER_DIR = join(ROOT, 'packages', 'helper')

const manifest = JSON.parse(await readFile(join(HOST_DIR, 'package.json'), 'utf8'))
const version = String(manifest.version)
const outputDir = join(ROOT, 'release', `dsh-pet-go-${version}`)

for (const [label, file] of [
  ['host bundle', join(HOST_DIR, 'lib', 'index.js')],
  ['helper build', join(HELPER_DIR, 'dist', 'main.js')],
]) {
  if (!existsSync(file)) {
    console.error(`missing ${label} (${file}); run \`pnpm build\` first`)
    process.exit(1)
  }
}

await rm(outputDir, { recursive: true, force: true })
await mkdir(outputDir, { recursive: true })

const copy = async (from, to) => {
  await mkdir(join(to, '..'), { recursive: true })
  await cp(from, to, { recursive: true })
}

await copy(join(HOST_DIR, 'lib'), join(outputDir, 'lib'))
await copy(join(HELPER_DIR, 'dist'), join(outputDir, 'helper'))
await copy(join(HOST_DIR, 'cordis.patch.yml'), join(outputDir, 'cordis.patch.yml'))
await copy(join(HOST_DIR, 'locale'), join(outputDir, 'locale'))
await copy(join(HOST_DIR, 'docs'), join(outputDir, 'docs'))
await copy(join(HOST_DIR, 'icon.svg'), join(outputDir, 'icon.svg'))
await copy(join(ROOT, 'README.md'), join(outputDir, 'README.md'))
await copy(join(ROOT, 'LICENSE'), join(outputDir, 'LICENSE'))
await copy(join(HELPER_DIR, 'assets', 'pets', 'baifan', 'NOTICE.md'), join(outputDir, 'NOTICE.md'))

await writeFile(
  join(outputDir, 'package.json'),
  JSON.stringify(
    {
      name: manifest.name,
      version,
      private: true,
      type: 'module',
      description: manifest.description,
      exports: manifest.exports,
      dsh: manifest.dsh,
      files: manifest.files,
    },
    null,
    2,
  ) + '\n',
  'utf8',
)

/** Every file under a directory, as paths relative to it. */
async function walk (directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await walk(full)))
    else found.push(relative(outputDir, full))
  }
  return found
}

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  return ok
}

for (const relativePath of [
  'lib/index.js',
  'helper/main.js',
  'helper/preload.cjs',
  'helper/package.json',
  'helper/renderer/panel.html',
  'helper/renderers/registry.js',
  'helper/assets/pets/baifan/pet.json',
  'cordis.patch.yml',
  'locale/zh.json',
  'locale/en.json',
  'docs/DETAIL.md',
  'docs/DETAIL.zh.md',
  'docs/preview.png',
  'icon.svg',
  'README.md',
  'LICENSE',
  'NOTICE.md',
  'package.json',
]) {
  check(`contains ${relativePath}`, existsSync(join(outputDir, relativePath)))
}

// Every locale that declares a detail document must ship that document.
for (const locale of ['zh.json', 'en.json']) {
  const parsed = JSON.parse(await readFile(join(outputDir, 'locale', locale), 'utf8'))
  const detail = parsed?.meta?.detail
  if (typeof detail === 'string') {
    check(`${locale} detail document exists`, existsSync(join(outputDir, detail)), detail)
  }
}

const entry = await import(pathToFileURL(join(outputDir, 'lib', 'index.js')).href)
check(
  'entry exports the plugin shape',
  typeof entry.apply === 'function' && typeof entry.name === 'string' && Array.isArray(entry.inject),
  `exports: ${Object.keys(entry).join(', ')}`,
)

const { resolveHelperDir } = await import(
  pathToFileURL(join(ROOT, 'packages', 'host', 'src', 'runtime', 'supervisor.ts')).href
)
const helperDir = resolveHelperDir({ packageRoot: outputDir, repoRoot: outputDir })
check('an installed package finds its helper', helperDir === join(outputDir, 'helper'), String(helperDir))

const files = await walk(outputDir)
const excluded = files.filter((file) =>
  /(^|[\\/])(src|tests|scripts|node_modules)([\\/]|$)/.test(file) || file.endsWith('.ts') || file.endsWith('.map'),
)
check('no sources, tests or source maps', excluded.length === 0, excluded.slice(0, 5).join(', '))

const totalBytes = (await Promise.all(files.map(async (file) => (await stat(join(outputDir, file))).size)))
  .reduce((sum, size) => sum + size, 0)

const failed = checks.filter((item) => !item.ok)
for (const item of checks) {
  console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.detail && !item.ok ? ` — ${item.detail}` : ''}`)
}
console.log(`\n${outputDir}`)
console.log(`${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MB`)

if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed`)
  process.exit(1)
}

console.log(`
Next:
  1. Install this directory in DSH (Plugins > add plugin) and run the device checklist.
  2. Remove the plugin again, then attach the folder to a GitHub release.
  3. npm publish (optional): cd "${outputDir}" && npm publish --access public`)
