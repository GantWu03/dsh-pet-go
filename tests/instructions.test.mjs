import { test } from 'node:test'
import assert from 'node:assert/strict'

import { agentsMd } from '../packages/host/src/index.js'

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
  assert.match(md, /^# 桌面小助手/m)
  for (const expected of ['Windows_NT', 'PowerShell 7', 'python.exe', 'node.exe', ENV.home, '2562x1602', ENV.scannedAt]) {
    assert.ok(md.includes(expected), `instructions should mention ${expected}`)
  }
})

test('the behaviour rules the model depends on are present', () => {
  const md = agentsMd(ENV)
  assert.match(md, /不要反问用户/)
  assert.match(md, /完整的读写和执行权限/)
  assert.match(md, /默认只读/)
  assert.match(md, /保持简洁/)
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
