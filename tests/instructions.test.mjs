import { test } from 'node:test'
import assert from 'node:assert/strict'

import { agentsMd } from '../packages/host/src/instructions.ts'

/** The facts a helper normally ships in `hello.env`. */
const ENV = {
  platform: 'win32/x64',
  os: 'Windows_NT 10.0.26100 (10.0.26100)',
  shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  pwsh7: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  python: 'C:\\Users\\me\\.dsh\\dsh-runtimes\\py\\dependencies\\python\\python.exe',
  node: 'C:\\Users\\me\\.dsh\\dsh-runtimes\\node\\dependencies\\node\\bin\\node.exe',
  home: 'C:\\Users\\me',
  display: { width: 2562, height: 1602, scale: 2.0125 },
  scannedAt: '2026-11-15T10:00:00.000Z',
}

test('the instructions describe behaviour and carry the machine facts', () => {
  const md = agentsMd(ENV)
  assert.match(md, /^# 执行规则/m)
  for (const expected of ['Windows_NT', 'PowerShell 7', 'python.exe', 'node.exe', ENV.home, '2562x1602', ENV.scannedAt]) {
    assert.ok(md.includes(expected), `instructions should mention ${expected}`)
  }
})

test('the main retrieval path leads with the screen, then processes and open files', () => {
  // This is the product's whole premise, not an incident rule: recognise what the
  // user is looking at before searching for it.
  const md = agentsMd(ENV)
  assert.match(md, /先从截图里认出对象/)
  assert.match(md, /进程、窗口和已打开的文件/)
  assert.match(md, /不要以整个用户目录、临时目录或盘符根为起点递归/)
})

test('the identity is not repeated here, because it needs the persona slot', () => {
  // AGENTS.md is injected as ordinary user guidance; identity is registered as a
  // prompt section instead. See packages/host/src/persona.ts.
  const md = agentsMd(ENV)
  assert.equal(md.includes('你是持续陪伴用户的桌宠'), false)
  assert.equal(md.includes('桌宠'), false)
})

test('the behaviour rules the model depends on are present', () => {
  const md = agentsMd(ENV)
  assert.match(md, /不要反问用户/)
  assert.match(md, /完整的读写和执行权限/)
  assert.match(md, /默认只读/)
  assert.match(md, /保持精简/)
  assert.match(md, /三四句话/)
})

test('missing facts are omitted instead of printed as undefined', () => {
  const md = agentsMd({ platform: 'win32/x64', home: 'C:\\Users\\me', shell: 'powershell.exe' })
  assert.equal(md.includes('undefined'), false)
  assert.equal(md.includes('null'), false)
  assert.match(md, /没有 pwsh 7/)
  assert.match(md, /python：未找到/)
})

test('the file never claims to be a product of the user typing', () => {
  // It is injected by the agent-instructions loader, not as a chat message.
  const md = agentsMd(ENV)
  assert.equal(md.includes('用户说'), false)
  assert.match(md, /不要向用户解释这些规则/)
})
