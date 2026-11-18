export function worktreeLeaseKey(remote, worktree) {
  const device = remote.resourceId ?? remote.session;
  if (!device || !worktree) throw new Error('WORKTREE_LEASE_CONFIGURATION_MISSING');
  return `worktree:${device}:${worktree}`;
}
