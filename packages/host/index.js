/**
 * Compatibility entry.
 *
 * `package.json` exports the built bundle (`./lib/index.js`); this file exists
 * because DSH resolves the plugin's entry URL once, when it loads the profile,
 * and an already-running instance keeps importing the URL it resolved earlier.
 * Re-exporting the bundle makes both entries run the same built code, so a
 * plugin reload uses the artifact and does not need a DSH restart.
 *
 * It is deleted in P3, after the profile has been loaded from `lib` at least
 * once.
 */
export * from './lib/index.js'
