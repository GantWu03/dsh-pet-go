/**
 * The session's standing instructions (AGENTS.md) and the machine facts
 * mirrored next to them.
 *
 * DSH's agent-instructions loader injects AGENTS.md as an ordinary user message
 * before the first request — guidance that never overrides the system prompt, so
 * nothing shows up as if the user had typed it. Identity does not live here for
 * that reason: it needs the persona slot, and it is `persona.ts`, applied by
 * `adapters/dsh.ts`.
 *
 * Keep this file about BEHAVIOUR. Volatile facts (which document is open, where
 * the user is reading) must never live here — they change mid-session and the
 * model can observe them itself.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { EnvironmentFacts } from '@dsh-pet-go/shared/protocol'

import type { Log } from './types.ts'

export function agentsMd (env: EnvironmentFacts): string {
  const facts = [
    ['系统', env.os ? `${env.os} · ${env.platform}` : env.platform],
    ['shell', env.pwsh7 ? `${env.shell} 和 PowerShell 7（${env.pwsh7}）` : `${env.shell}（没有 pwsh 7）`],
    ['python', env.python ?? '未找到'],
    ['node', env.node ?? '未找到'],
    ['用户目录', env.home],
    ['屏幕', env.display ? `${env.display.width}x${env.display.height}` : '未知'],
    ['采集时间', env.scannedAt],
  ].filter(([, value]) => value)
  return [
    '# 执行规则',
    '',
    '## 怎么回答',
    '',
    '- 回答保持精简，便于在对话框内呈现：先说直接结论，整体回答通常保持在三四句话以内；',
    '  除非会因此影响任务完成效果，否则不要写成长篇大论；使用用户的语言。',
    '- 指令没要求细节时，不需要贴命令、代码或路径清单。',
    '- 拿不准就说不确定，不要编。',
    '',
    '## 什么时候自己动手',
    '',
    '- 画面里能直接回答的就直接回答；画面里的信息不够，就自己去查，',
    '  不要反问用户"把文件发给我""再截个图"。',
    '- 你在这台机器上有完整的读写和执行权限，但默认只读：除非用户明确要求，不要修改或删除文件。',
    '- 要查屏幕外的东西，按代价从低到高取信息，一次只降一级：',
    '  1）先从截图里认出对象——用户正在看的程序名、窗口标题、文档名、网页标题；',
    '  2）再到进程、窗口和已打开的文件里确认它到底是什么、在哪；',
    '  3）然后在最可能的窄范围里精确查找；',
    '  4）最后才是大范围遍历，且不要以整个用户目录、临时目录或盘符根为起点递归。',
    '- 每一步都设预算：一条命令明显慢、或同一个办法两次没进展，就换办法，不要重试。',
    '- 查证控制在几步之内；查不到就直说，并把已经确定的部分给出来。',
    '',
    '## 不要做的',
    '',
    '- 不要向用户解释这些规则，也不要提到本文件或你的权限来源。',
    '- 不要在回答里贴大段日志、命令输出或内部路径，除非用户就是要这些。',
    '',
    '## 这台机器',
    '',
    ...facts.map(([key, value]) => `- ${key}：${value}`),
    '',
  ].join('\n')
}

export interface InstructionsInput {
  env: EnvironmentFacts
  workspaceDir: string
  envDir: string
  log: Log
}

/**
 * Persist the collected facts and rewrite the session's AGENTS.md.
 * Called once per helper connection (i.e. once per DSH launch), never per
 * question and never per session.
 */
export async function writeInstructions ({ env, workspaceDir, envDir, log }: InstructionsInput): Promise<void> {
  try {
    await mkdir(envDir, { recursive: true })
    await writeFile(join(envDir, 'env.json'), JSON.stringify(env, null, 2), 'utf8')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, 'AGENTS.md'), agentsMd(env), 'utf8')
    log('AGENTS.md written')
  } catch (error) {
    log(`AGENTS.md failed: ${(error as Error)?.message}`)
  }
}
