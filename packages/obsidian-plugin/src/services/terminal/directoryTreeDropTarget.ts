/**
 * A directory row is itself a valid destination. A file row represents its
 * containing directory because files cannot contain a dropped Vault entry.
 */
export function resolveDirectoryTreeDropTarget(
  parentPath: string,
  fullPath: string,
  isDirectory: boolean,
): string {
  return isDirectory ? fullPath : parentPath;
}
