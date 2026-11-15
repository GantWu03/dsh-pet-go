/** Shared shapes the host modules use, kept out of any one of them. */

export type Log = (line: string) => void

/** Paths the plugin writes inside the DSH home directory. */
export interface CompanionPaths {
  /** DSH home: `$DSH_HOME` or `~/.dsh`. */
  dshHome: string
  /** Everything this plugin owns: state, log, machine facts, the workspace. */
  stateDir: string
  /** Directory the dedicated session works in (holds AGENTS.md). */
  workspaceDir: string
  /** Where the latest machine facts are mirrored for humans/debugging. */
  envDir: string
  stateFile: string
  logFile: string
}

/**
 * Where older builds kept the same files (`$DSH_HOME/companion`). Migrated once
 * on startup; see `migrate.ts`.
 */
export interface LegacyPaths {
  legacyDir: string
}
