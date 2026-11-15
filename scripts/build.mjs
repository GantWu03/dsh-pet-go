/**
 * Build both deployable artifacts.
 *
 * host   -> packages/host/lib/index.js      (Cordis plugin entry, bundled ESM)
 * helper -> packages/helper/dist/           (Electron app directory)
 *
 * The two packages are intentionally built together: the host resolves the
 * helper's `dist` as a sibling directory, so a half-built pair is not a valid
 * install.
 */
import { build } from 'esbuild'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOST_DIR = join(ROOT, 'packages', 'host')
const HELPER_DIR = join(ROOT, 'packages', 'helper')

/** Shared esbuild settings: Node ESM, Electron provided at runtime. */
const common = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  logLevel: 'warning',
  legalComments: 'none',
  charset: 'utf8',
}

/**
 * @param {import('esbuild').BuildResult} result
 * @returns {string}
 */
function report (result) {
  return (result.metafile?.outputs
    ? Object.entries(result.metafile.outputs)
        .map(([file, output]) => `${file} ${(output.bytes / 1024).toFixed(1)}kB`)
        .join(', ')
    : 'ok')
}

async function buildHost () {
  const lib = join(HOST_DIR, 'lib')
  await rm(lib, { recursive: true, force: true })
  const result = await build({
    ...common,
    entryPoints: [join(HOST_DIR, 'src', 'index.ts')],
    outfile: join(lib, 'index.js'),
    metafile: true,
  })
  return `host/lib/index.js (${report(result)})`
}

async function buildHelper () {
  const dist = join(HELPER_DIR, 'dist')
  await rm(dist, { recursive: true, force: true })
  await mkdir(dist, { recursive: true })
  const result = await build({
    ...common,
    entryPoints: [join(HELPER_DIR, 'src', 'main', 'index.ts')],
    outfile: join(dist, 'main.js'),
    metafile: true,
  })
  // Pages, renderers and artwork ship verbatim: the renderer is plain JS loaded
  // by Chromium, and the pages reference these directories by relative path.
  for (const directory of ['renderer', 'renderers', 'assets']) {
    await cp(join(HELPER_DIR, directory), join(dist, directory), { recursive: true })
  }
  await cp(join(HELPER_DIR, 'preload.cjs'), join(dist, 'preload.cjs'))
  // The helper is started as `electron <dist>`, so `dist` must be a valid app
  // directory of its own. Its name decides Electron's userData directory, so it
  // must stay identical to the package name.
  const manifest = JSON.parse(await readFile(join(HELPER_DIR, 'package.json'), 'utf8'))
  await writeFile(
    join(dist, 'package.json'),
    JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        private: true,
        type: 'module',
        main: 'main.js',
        description: manifest.description,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  return `helper/dist/ (${report(result)})`
}

const started = Date.now()
for (const buildOne of [buildHost, buildHelper]) {
  console.log(`built ${await buildOne()}`)
}
console.log(`done in ${Date.now() - started}ms`)
