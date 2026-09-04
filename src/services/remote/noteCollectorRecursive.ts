/**
 * Recursive note+link collection for the two v3.1 send entries (right-click
 * "send to terminal and execute", note toolbar "send to terminal") — see
 * `输出文档/v3.1 需求文档采集.md` §4.
 *
 * v2.0's `collect()` deliberately does not follow links to other notes (doc
 * 10.1). v3.1 keeps that single-note rule intact and layers a walk on top of
 * it: every linked note `collect()` reports via `linkedNotes` is itself
 * `collect()`-ed, and so on, with no depth limit and note-level cycle
 * guarding (confirmed answers to questions 1/2). The root note's own
 * `collect()` failure stays fatal, unchanged from v2.0; a failure on a
 * recursively-discovered note is skipped with its reason instead of failing
 * the whole batch (confirmed answer to question 7).
 *
 * v1.9 R-02 adds a second pass, gated behind the optional `backlinksOf`
 * parameter (`sendBacklinkedNotes` setting): once the forward walk above is
 * done, every markdown note it found is also checked for *backlinks* — other
 * notes that link to it — and those are pulled in too, recursively (backlink
 * of a backlink), sharing the same `visitedNotes` cycle guard so a forward +
 * backlink mix can never loop. A backlink-discovered note contributes itself
 * and its own direct attachments only; its outgoing links are not expanded
 * (only its own backlinks are, in the next round) and attachments never get
 * their own backlinks queried (design doc §3.3, Q2/Q3).
 */

import { collect, extensionOf, type CollectedFile, type LinkSource } from './noteCollector.ts';

export interface SkippedNote {
  path: string;
  reason: string;
}

export interface RecursiveCollectResult {
  ok: boolean;
  files: CollectedFile[];
  /** Populated when ok is false (root note's own collect() failed). */
  error?: string;
  /** Merged skip log from every note visited, for the debug log. */
  skipped: string[];
  /** Linked notes that failed to collect and were skipped instead. */
  skippedNotes: SkippedNote[];
}

export function collectRecursive(
  rootSource: LinkSource,
  sourceFor: (notePath: string) => LinkSource | null,
  /** R-02: vault-relative paths of notes that link to `notePath`. Omit to keep v1.8 forward-only behavior. */
  backlinksOf?: (notePath: string) => string[]
): RecursiveCollectResult {
  const rootResult = collect(rootSource);
  if (!rootResult.ok) {
    return { ok: false, files: [], error: rootResult.error, skipped: rootResult.skipped, skippedNotes: [] };
  }

  const files: CollectedFile[] = [...rootResult.files];
  const seen = new Set(files.map((f) => f.relativePath));
  const skipped = [...rootResult.skipped];
  const skippedNotes: SkippedNote[] = [];
  const visitedNotes = new Set([rootResult.files[0].relativePath]);

  const queue = [...rootResult.linkedNotes];

  while (queue.length > 0) {
    const notePath = queue.shift()!;
    if (visitedNotes.has(notePath)) continue;
    visitedNotes.add(notePath);

    const subSource = sourceFor(notePath);
    if (!subSource) {
      skippedNotes.push({ path: notePath, reason: `${notePath} no longer exists in the vault.` });
      continue;
    }

    const subResult = collect(subSource);
    if (!subResult.ok) {
      skippedNotes.push({ path: notePath, reason: subResult.error ?? 'unknown error' });
      continue;
    }

    for (const file of subResult.files) {
      if (seen.has(file.relativePath)) continue;
      seen.add(file.relativePath);
      files.push({ ...file, index: files.length });
    }
    skipped.push(...subResult.skipped);

    for (const linked of subResult.linkedNotes) {
      if (!visitedNotes.has(linked)) queue.push(linked);
    }
  }

  if (backlinksOf) {
    // Seeded from the successfully collected notes only (design doc §3.3's "S"),
    // not `visitedNotes`, which also holds notes that failed to collect above.
    const backlinkQueue = files.filter((f) => extensionOf(f.relativePath) === 'md').map((f) => f.relativePath);

    while (backlinkQueue.length > 0) {
      const notePath = backlinkQueue.shift()!;

      for (const sourcePath of backlinksOf(notePath)) {
        if (visitedNotes.has(sourcePath)) continue;
        visitedNotes.add(sourcePath);

        const subSource = sourceFor(sourcePath);
        if (!subSource) {
          skippedNotes.push({ path: sourcePath, reason: `${sourcePath} no longer exists in the vault.` });
          continue;
        }

        const subResult = collect(subSource);
        if (!subResult.ok) {
          skippedNotes.push({ path: sourcePath, reason: subResult.error ?? 'unknown error' });
          continue;
        }

        for (const file of subResult.files) {
          if (seen.has(file.relativePath)) continue;
          seen.add(file.relativePath);
          files.push({ ...file, index: files.length, origin: 'backlink' });
        }
        skipped.push(...subResult.skipped);

        // Backlink of a backlink (Q2), but never forward-expand `subResult.linkedNotes` here.
        backlinkQueue.push(sourcePath);
      }
    }
  }

  return { ok: true, files, skipped, skippedNotes };
}
