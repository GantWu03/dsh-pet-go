import { test } from 'node:test'
import assert from 'node:assert/strict'

import { COMPANION_PERSONA } from '../packages/host/src/persona.ts'
import { createDshAdapter } from '../packages/host/src/adapters/dsh.ts'

/**
 * A fake DSH narrow enough to observe the two things that matter: the preset is
 * mounted first, and the persona section is registered in the agent's own scope.
 * The agent factory calls `setup` for both create and resume, so the fake does too.
 */
function createFakeDsh () {
  const timeline = []
  const sections = []
  const agentContext = {
    systemPrompt: {
      section: (input) => {
        timeline.push('section')
        sections.push(input)
        return () => {}
      },
      getSectionOrder: (name) => (name === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : -1),
    },
  }
  const handle = { agent: { id: 'session-fake', session: { append: () => {} } } }
  return {
    timeline,
    sections,
    ctx: {
      agents: {
        get: () => undefined,
        create: async (input) => {
          timeline.push('create')
          await input.setup?.(agentContext)
          return handle
        },
        resume: async (input) => {
          timeline.push('resume')
          await input.setup?.(agentContext)
          return handle
        },
      },
      attachments: { saveImage: async () => ({ id: 'att' }) },
      get: (name) => (name === 'agentPresets'
        ? { mount: async (_agentContext, id) => { timeline.push('mount'); return { id } } }
        : undefined),
      on: () => () => {},
    },
    agentContext,
  }
}

test('the persona reads as one identity, and is safe to interpolate', () => {
  assert.match(COMPANION_PERSONA, /^你是持续陪伴用户的桌宠。/)
  assert.ok(COMPANION_PERSONA.includes('就像你们一起看着同一块屏幕。'))
  assert.match(COMPANION_PERSONA, /能在具体情景下自己想办法解决问题。$/)
  // A `{{…}}` group would be resolved against registered prompt variables and
  // fail assembly when unknown.
  assert.equal(COMPANION_PERSONA.includes('{{'), false)
})

test('a created session mounts its preset and then takes the persona slot', async () => {
  const fake = createFakeDsh()
  const logs = []
  const adapter = createDshAdapter(fake.ctx, { log: (line) => logs.push(line), persona: COMPANION_PERSONA })

  await adapter.sessions.create({ sessionId: 'session-fake', cwd: 'C:\\workspace', preset: 'standard' })

  assert.deepEqual(fake.timeline, ['create', 'mount', 'section'])
  assert.deepEqual(fake.sections, [{
    name: 'deployment:persona-prefix',
    order: 0,
    text: COMPANION_PERSONA,
  }])
  assert.ok(logs.some((line) => line.includes('preset mounted: standard')))
  assert.ok(logs.some((line) => line.includes('persona applied')))
})

test('a resumed session takes the persona slot again, because DSH rebuilt the preset', async () => {
  const fake = createFakeDsh()
  const adapter = createDshAdapter(fake.ctx, { log: () => {}, persona: COMPANION_PERSONA })

  await adapter.sessions.resume('session-fake')

  assert.deepEqual(fake.timeline, ['resume', 'section'])
  assert.equal(fake.sections.length, 1)
  assert.equal(fake.sections[0].text, COMPANION_PERSONA)
})

test('a missing persona slot is logged, not thrown', async () => {
  const fake = createFakeDsh()
  const logs = []
  const adapter = createDshAdapter(fake.ctx, { log: (line) => logs.push(line), persona: COMPANION_PERSONA })
  fake.agentContext.systemPrompt = undefined

  await adapter.sessions.create({ sessionId: 'session-fake', cwd: 'C:\\workspace', preset: 'standard' })

  assert.ok(logs.some((line) => line.startsWith('persona skipped')))
})

test('without a persona nothing is registered, so an unset value cannot blank the prompt', async () => {
  const fake = createFakeDsh()
  const adapter = createDshAdapter(fake.ctx, { log: () => {} })

  await adapter.sessions.create({ sessionId: 'session-fake', cwd: 'C:\\workspace', preset: 'standard' })

  assert.deepEqual(fake.timeline, ['create', 'mount'])
  assert.deepEqual(fake.sections, [])
})
