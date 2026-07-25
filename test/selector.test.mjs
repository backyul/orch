import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelector } from '../src/selector.js';

// Real captured Claude Code permission dialog (WebFetch), verbatim shape.
const PERMISSION_DIALOG = `
 Fetch

   url: "https://example.com", prompt: "What is the page title?"
   Claude wants to fetch content from example.com

 Do you want to allow Claude to fetch this content?
 ❯ 1. Yes
   2. Yes, and don't ask again for example.com
   3. No, and tell Claude what to do differently (esc)
`;

test('parseSelector extracts the question and numbered options, stripping (esc)', () => {
  const r = parseSelector(PERMISSION_DIALOG);
  assert.equal(r.question, 'Do you want to allow Claude to fetch this content?');
  assert.deepEqual(r.options, [
    'Yes',
    "Yes, and don't ask again for example.com",
    'No, and tell Claude what to do differently',
  ]);
});

test('parseSelector returns null when there is no selector', () => {
  assert.equal(parseSelector('just some output\nno options here\n❯ '), null);
});

test('parseSelector ignores a stray single "1." with no second option', () => {
  assert.equal(parseSelector('1. only one thing\nmore text'), null);
});

test('parseSelector stitches options that wrap onto continuation lines (narrow pane)', () => {
  const wrapped = `
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for
      example.com commands
   3. No, and tell Claude what to do
      differently (esc)
 Enter to select · ↑/↓ to navigate · Esc to cancel
`;
  const r = parseSelector(wrapped);
  assert.equal(r.question, 'Do you want to proceed?');
  assert.deepEqual(r.options, [
    'Yes',
    "Yes, and don't ask again for example.com commands",
    'No, and tell Claude what to do differently',
  ]);
});

test('parseSelector takes the last complete option run', () => {
  const r = parseSelector('1. old\n2. stale\n\nPick one?\n❯ 1. A\n  2. B');
  assert.equal(r.question, 'Pick one?');
  assert.deepEqual(r.options, ['A', 'B']);
});
