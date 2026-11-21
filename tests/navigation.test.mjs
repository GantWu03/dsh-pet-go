/**
 * The pet windows must never become a browser.
 *
 * Regression: a Markdown link in an answer navigated the panel window, which
 * then showed GitHub's 404 page until the helper was killed. Two layers now keep
 * that from happening — this suite covers both the policy and the wiring.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { externalTarget, isRendererUrl } from '../packages/helper/src/navigation.ts'

const RENDERER = fileURLToPath(new URL('../packages/helper/dist/renderer', import.meta.url))
const pageUrl = (name) => pathToFileURL(join(RENDERER, name)).href

test('http(s) links are the ones that reach the browser', () => {
  assert.equal(
    externalTarget('https://github.com/GantWu03/dsh-pet-go'),
    'https://github.com/GantWu03/dsh-pet-go',
  )
  // Surrounding whitespace comes from Markdown and means nothing.
  assert.equal(externalTarget(' http://example.com/a?b=1 '), 'http://example.com/a?b=1')
  // Normalised, so the browser never gets a half-formed URL.
  assert.equal(externalTarget('HTTPS://EXAMPLE.com/x'), 'https://example.com/x')
})

test('every other scheme is refused instead of opened', () => {
  for (const url of [
    'file:///C:/Windows/win.ini',
    'C:\\Users\\me\\.dsh\\profiles\\desktop\\cordis.patch.yml',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'mailto:someone@example.com',
    'ftp://example.com/x',
    '',
    '   ',
    'not a url',
  ]) {
    assert.equal(externalTarget(url), null, `${url} must not open`)
  }
  for (const value of [undefined, null, 42, {}, ['https://example.com']]) {
    assert.equal(externalTarget(value), null, `${String(value)} must not open`)
  }
})

test('the pet keeps its own pages', () => {
  assert.equal(isRendererUrl(pageUrl('panel.html'), RENDERER), true)
  assert.equal(isRendererUrl(pageUrl('ball.html'), RENDERER), true)
  assert.equal(isRendererUrl(pageUrl('app.css'), RENDERER), true)
})

test('nothing outside the renderer directory may load in a pet window', () => {
  // The helper's own main.js sits one level up from the pages.
  assert.equal(isRendererUrl(pageUrl('../main.js'), RENDERER), false)
  // A sibling directory whose name happens to share the prefix.
  assert.equal(isRendererUrl(pageUrl('../renderer-evil/panel.html'), RENDERER), false, 'prefix match is not enough')
  assert.equal(isRendererUrl('file:///C:/Windows/win.ini', RENDERER), false)
  assert.equal(isRendererUrl('https://github.com', RENDERER), false)
  assert.equal(isRendererUrl('about:blank', RENDERER), false)
  assert.equal(isRendererUrl(undefined, RENDERER), false)
})

test('both windows install the lock before they load their page', () => {
  const source = readFileSync(new URL('../packages/helper/src/windows.ts', import.meta.url), 'utf8')
  assert.match(source, /lockNavigation\(ballWin\)/, 'the ball window is locked')
  assert.match(source, /lockNavigation\(panelWin\)/, 'the panel window is locked')
  assert.match(source, /setWindowOpenHandler/, 'popups are refused')
  assert.match(source, /on\('will-navigate', stay\)/, 'link navigation is cancelled')
})

test('the renderer hands links off instead of following them', () => {
  const source = readFileSync(new URL('../packages/helper/renderer/panel.js', import.meta.url), 'utf8')
  assert.match(source, /anchor\.target = '_blank'/, 'an untouched click opens nothing in place')
  assert.match(source, /openExternal/, 'the URL goes to the main process')
  assert.match(source, /addEventListener\('click', followLink, true\)/, 'the click is intercepted')
  assert.match(source, /addEventListener\('auxclick', followLink, true\)/, 'middle-click is intercepted too')
  // No renderer-side navigation of its own window, through any spelling.
  assert.doesNotMatch(source, /(?:location\.(?:href|assign|replace)|window\.open)\s*\(/)
  assert.doesNotMatch(source, /location\.href\s*=/)
})
