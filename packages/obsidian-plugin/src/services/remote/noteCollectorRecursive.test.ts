import * as assert from 'node:assert/strict';
import test from 'node:test';

import { collectRecursive } from './noteCollectorRecursive.ts';
import type { LinkSource, ResolvedLink } from './noteCollector.ts';

/** A tiny fake vault: each note has its own links; sizes cover notes and attachments alike. */
function vault(notes: Record<string, ResolvedLink[]>, sizes: Record<string, number>) {
  return (path: string): LinkSource | null => {
    if (!(path in notes)) return null;
    return {
      rootNotePath: path,
      links: () => notes[path],
      sizeOf: (p) => (p in sizes ? sizes[p] : null),
    };
  };
}

test('a note with no links collects just itself', () => {
  const sourceFor = vault({ 'root.md': [] }, { 'root.md': 10 });
  const result = collectRecursive(sourceFor('root.md')!, sourceFor);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((f) => f.relativePath), ['root.md']);
});

test('a linked note is recursed into, including its own attachments', () => {
  const sourceFor = vault(
    {
      'root.md': [{ raw: 'b', resolved: 'b.md' }],
      'b.md': [{ raw: 'img', resolved: 'img.png' }],
    },
    { 'root.md': 10, 'b.md': 20, 'img.png': 5 }
  );
  const result = collectRecursive(sourceFor('root.md')!, sourceFor);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((f) => f.relativePath), ['root.md', 'b.md', 'img.png']);
});

test('recursion has no depth limit', () => {
  const chainLength = 20;
  const notes: Record<string, ResolvedLink[]> = {};
  const sizes: Record<string, number> = {};
  for (let i = 0; i < chainLength; i++) {
    const path = `n${i}.md`;
    const next = i + 1 < chainLength ? [{ raw: `n${i + 1}`, resolved: `n${i + 1}.md` }] : [];
    notes[path] = next;
    sizes[path] = 1;
  }
  const sourceFor = vault(notes, sizes);
  const result = collectRecursive(sourceFor('n0.md')!, sourceFor);
  assert.equal(result.ok, true);
  assert.equal(result.files.length, chainLength);
});

test('a cycle between linked notes does not loop forever and each note appears once', () => {
  const sourceFor = vault(
    {
      'root.md': [{ raw: 'a', resolved: 'a.md' }],
      'a.md': [{ raw: 'b', resolved: 'b.md' }],
      'b.md': [{ raw: 'a', resolved: 'a.md' }],
    },
    { 'root.md': 1, 'a.md': 1, 'b.md': 1 }
  );
  const result = collectRecursive(sourceFor('root.md')!, sourceFor);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((f) => f.relativePath).sort(), ['a.md', 'b.md', 'root.md']);
});

test('a note that no longer exists is skipped with a reason, not fatal', () => {
  const sourceFor = vault(
    {
      'root.md': [
        { raw: 'gone', resolved: 'gone.md' },
        { raw: 'b', resolved: 'b.md' },
      ],
      'b.md': [],
    },
    { 'root.md': 1, 'b.md': 1 }
  );
  const result = collectRecursive(sourceFor('root.md')!, sourceFor);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((f) => f.relativePath).sort(), ['b.md', 'root.md']);
  assert.equal(result.skippedNotes.length, 1);
  assert.equal(result.skippedNotes[0].path, 'gone.md');
  assert.match(result.skippedNotes[0].reason, /no longer exists/);
});

test('a linked note with a broken attachment is skipped with a reason, the rest keeps going', () => {
  const sourceFor = vault(
    {
      'root.md': [
        { raw: 'broken', resolved: 'broken.md' },
        { raw: 'b', resolved: 'b.md' },
      ],
      'broken.md': [{ raw: 'missing.png', resolved: null }],
      'b.md': [],
    },
    { 'root.md': 1, 'broken.md': 1, 'b.md': 1 }
  );
  const result = collectRecursive(sourceFor('root.md')!, sourceFor);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((f) => f.relativePath).sort(), ['b.md', 'root.md']);
  assert.equal(result.skippedNotes.length, 1);
  assert.equal(result.skippedNotes[0].path, 'broken.md');
  assert.match(result.skippedNotes[0].reason, /missing\.png/);
});

test('an attachment referenced by two different linked notes is sent once', () => {
  const sourceFor = vault(
    {
      'root.md': [
        { raw: 'a', resolved: 'a.md' },
        { raw: 'b', resolved: 'b.md' },
      ],
      'a.md': [{ raw: 'shared', resolved: 'shared.png' }],
      'b.md': [{ raw: 'shared', resolved: 'shared.png' }],
    },
    { 'root.md': 1, 'a.md': 1, 'b.md': 1, 'shared.png': 5 }
  );
  const result = collectRecursive(sourceFor('root.md')!, sourceFor);
  assert.equal(result.ok, true);
  const sharedCount = result.files.filter((f) => f.relativePath === 'shared.png').length;
  assert.equal(sharedCount, 1);
});

test("the root note's own broken attachment is still fatal, unchanged from v2.0", () => {
  const sourceFor = vault({ 'root.md': [{ raw: 'missing.png', resolved: null }] }, { 'root.md': 1 });
  const result = collectRecursive(sourceFor('root.md')!, sourceFor);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /missing\.png/);
});

// v1.9 R-02: backlink recursion, gated behind the optional `backlinksOf` param.

/** A fixed reverse-link table: maps a target path to the notes that link to it. */
function backlinks(table: Record<string, string[]>) {
  return (path: string): string[] => table[path] ?? [];
}

test('omitting backlinksOf reproduces v1.8 forward-only behavior', () => {
  const sourceFor = vault({ 'root.md': [] }, { 'root.md': 1, 'b.md': 1 });
  const result = collectRecursive(sourceFor('root.md')!, sourceFor);
  assert.deepEqual(result.files.map((f) => f.relativePath), ['root.md']);
});

test('a note that links to the root is pulled in as a backlink', () => {
  const sourceFor = vault({ 'root.md': [], 'b.md': [] }, { 'root.md': 1, 'b.md': 2 });
  const backlinksOf = backlinks({ 'root.md': ['b.md'] });
  const result = collectRecursive(sourceFor('root.md')!, sourceFor, backlinksOf);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((f) => f.relativePath).sort(), ['b.md', 'root.md']);
  const backlinkFile = result.files.find((f) => f.relativePath === 'b.md');
  assert.equal(backlinkFile?.origin, 'backlink');
  const rootFile = result.files.find((f) => f.relativePath === 'root.md');
  assert.equal(rootFile?.origin, undefined);
});

test('backlinks recurse: a backlink of a backlink is also included (Q2)', () => {
  const sourceFor = vault(
    { 'root.md': [], 'b.md': [], 'c.md': [] },
    { 'root.md': 1, 'b.md': 1, 'c.md': 1 }
  );
  const backlinksOf = backlinks({ 'root.md': ['b.md'], 'b.md': ['c.md'] });
  const result = collectRecursive(sourceFor('root.md')!, sourceFor, backlinksOf);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((f) => f.relativePath).sort(), ['b.md', 'c.md', 'root.md']);
});

test('a backlink note contributes its own direct attachments, but its own links are not forward-expanded', () => {
  const sourceFor = vault(
    {
      'root.md': [],
      'b.md': [
        { raw: 'img', resolved: 'img.png' },
        { raw: 'other', resolved: 'other.md' },
      ],
      'other.md': [],
    },
    { 'root.md': 1, 'b.md': 1, 'img.png': 5, 'other.md': 1 }
  );
  const backlinksOf = backlinks({ 'root.md': ['b.md'] });
  const result = collectRecursive(sourceFor('root.md')!, sourceFor, backlinksOf);
  assert.equal(result.ok, true);
  // b.md's attachment comes along, but b.md's link to other.md is not followed.
  assert.deepEqual(result.files.map((f) => f.relativePath).sort(), ['b.md', 'img.png', 'root.md']);
});

test('an attachment never has its own backlinks queried (Q3)', () => {
  const sourceFor = vault(
    { 'root.md': [{ raw: 'img', resolved: 'img.png' }] },
    { 'root.md': 1, 'img.png': 5 }
  );
  let queried: string[] = [];
  const backlinksOf = (path: string): string[] => {
    queried.push(path);
    return [];
  };
  const result = collectRecursive(sourceFor('root.md')!, sourceFor, backlinksOf);
  assert.equal(result.ok, true);
  assert.deepEqual(queried, ['root.md']);
});

test('a forward + backward mix does not loop and each note appears once', () => {
  const sourceFor = vault(
    {
      'root.md': [{ raw: 'a', resolved: 'a.md' }],
      'a.md': [],
      'b.md': [],
    },
    { 'root.md': 1, 'a.md': 1, 'b.md': 1 }
  );
  // b links to root, and a links back to b: forward finds a.md; backward finds b.md via root,
  // then would try to re-discover a.md via b -> must not duplicate or loop.
  const backlinksOf = backlinks({ 'root.md': ['b.md'], 'b.md': ['a.md'] });
  const result = collectRecursive(sourceFor('root.md')!, sourceFor, backlinksOf);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((f) => f.relativePath).sort(), ['a.md', 'b.md', 'root.md']);
});

test('a backlink note that fails to collect is skipped with a reason, not fatal', () => {
  const sourceFor = vault({ 'root.md': [], 'broken.md': [{ raw: 'missing.png', resolved: null }] }, { 'root.md': 1, 'broken.md': 1 });
  const backlinksOf = backlinks({ 'root.md': ['broken.md'] });
  const result = collectRecursive(sourceFor('root.md')!, sourceFor, backlinksOf);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((f) => f.relativePath), ['root.md']);
  assert.equal(result.skippedNotes.length, 1);
  assert.equal(result.skippedNotes[0].path, 'broken.md');
});

test('a backlink to a note that no longer exists is skipped with a reason', () => {
  const sourceFor = vault({ 'root.md': [] }, { 'root.md': 1 });
  const backlinksOf = backlinks({ 'root.md': ['gone.md'] });
  const result = collectRecursive(sourceFor('root.md')!, sourceFor, backlinksOf);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((f) => f.relativePath), ['root.md']);
  assert.equal(result.skippedNotes.length, 1);
  assert.equal(result.skippedNotes[0].path, 'gone.md');
  assert.match(result.skippedNotes[0].reason, /no longer exists/);
});
