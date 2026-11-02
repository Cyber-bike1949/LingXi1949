import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateDirectoryTooltipPosition } from './directoryTreeTooltip.ts';

test('directory tooltip prefers the right side without covering the row', () => {
  assert.deepEqual(
    calculateDirectoryTooltipPosition(
      { left: 20, right: 220, top: 100, bottom: 124, width: 200, height: 24 },
      { width: 180, height: 48 },
      { width: 800, height: 600 },
    ),
    { left: 228, top: 88, side: 'right' },
  );
});

test('directory tooltip flips left and stays inside viewport edges', () => {
  assert.deepEqual(
    calculateDirectoryTooltipPosition(
      { left: 560, right: 790, top: 2, bottom: 26, width: 230, height: 24 },
      { width: 180, height: 48 },
      { width: 800, height: 600 },
    ),
    { left: 372, top: 8, side: 'left' },
  );
});
