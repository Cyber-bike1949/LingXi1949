import { nextNodes } from './scheduler.mjs';

export function nextAction(nodes) {
  const node = nextNodes(nodes)[0];
  if (!node) return null;
  return { kind: node.kind };
}
