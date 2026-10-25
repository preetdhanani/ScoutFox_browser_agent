/**
 * The build stamp: which build is loaded in the browser is "whatever was last built AND reloaded", not what is in the
 * editor, and a pasted log has no other way to say it. vite.config.mjs makes the stamp, src/shared/build.ts reads it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error vite.config.mjs is plain JS with no declaration file
import { buildStamp } from '../vite.config.mjs';
import { BUILD_STAMP, IS_BUILD } from '../src/shared/build.ts';

test('the stamp is an ISO time, a space, and a git short hash (optionally -dirty) or "no-git"', () => {
  assert.match(buildStamp(), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (?:no-git|[0-9a-f]{7,40}(?:-dirty)?)$/);
});

test('the stamp is the same for every pass of one build run', () => {
  assert.equal(buildStamp(), buildStamp());
});

test('run from source (no bundler define) the constant says so, and importing it does not throw', () => {
  assert.equal(BUILD_STAMP, 'not a build (run from source)');
  assert.equal(IS_BUILD, false, 'so the panel skips its worker build check under the unit tests');
});
