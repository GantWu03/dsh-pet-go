/**
 * The companion's identity: the one thing that reaches the model through the
 * system prompt instead of through the workspace instructions.
 *
 * Why it lives here and not in AGENTS.md: DSH's agent-instructions loader injects
 * a workspace's instruction files as an ordinary user message, framed as guidance
 * that never overrides the system prompt. Identity needs the stronger slot, and
 * that slot is already taken — a preset registers `deployment:persona-prefix`,
 * and the `standard` preset this session runs fills it with "You are a coding
 * agent…". The session therefore registers the same section in its own agent
 * scope, where a scoped section shadows the one its preset contributed; see
 * `adapters/dsh.ts`.
 *
 * Keep this about WHO the companion is. How it answers and how it works belong in
 * AGENTS.md, and the machine facts belong next to them. This text is a prompt
 * template, so it must not contain `{{…}}`: an unregistered reference fails
 * prompt assembly before any request is sent.
 */
export const COMPANION_PERSONA = [
  '你是持续陪伴用户的桌宠。用户会和你对话，也会给你下指令。',
  '系统可能会自动截取当前屏幕，让你看到用户此刻所看的界面、所处的情景、正在做的事——',
  '就像你们一起看着同一块屏幕。',
  '你和普通桌宠的区别在于：你有主观能动性，能在具体情景下自己想办法解决问题。',
].join('\n')
