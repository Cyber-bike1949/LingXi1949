import type { TransferEntry, TransferFileResult, TransferResultPayload } from './terminalStreamFrame.ts';

/** Returns only success receipts whose index and path match the sent manifest. */
export function confirmedTransferReceipts(result: TransferResultPayload, entries: TransferEntry[]): TransferFileResult[] {
  if (result.files === undefined) {
    return result.success
      ? entries.map((entry) => ({ fileIndex: entry.index, relativePath: entry.relativePath, status: 'success' }))
      : [];
  }
  const manifest = new Map(entries.map((entry) => [entry.index, entry.relativePath]));
  const seen = new Set<number>();
  return result.files.filter((receipt) => {
    if (receipt.status !== 'success' || manifest.get(receipt.fileIndex) !== receipt.relativePath) return false;
    if (seen.has(receipt.fileIndex)) return false;
    seen.add(receipt.fileIndex);
    return true;
  });
}

/** Only accept receipts matching the manifest; legacy failures prove no file committed. */
export function confirmedTransferPaths(result: TransferResultPayload, entries: TransferEntry[]): string[] {
  return confirmedTransferReceipts(result, entries).map((receipt) => receipt.relativePath);
}
