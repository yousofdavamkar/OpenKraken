import { snapshotPartSchema, type Ref, type ServiceResult } from '@openkraken/ipc-contract';

/** Main keeps the validated refs private until the same opening supplies its complete snapshot. */
export class SnapshotTransfer {
  private refs?: (string | Ref)[];
  private receivedRefs = false;
  constructor(
    readonly id: string,
    readonly transferId: string,
  ) {}

  receive(message: {
    id: unknown;
    transferId: unknown;
    snapshotPart: unknown;
  }): ServiceResult | undefined {
    if (message.id !== this.id || message.transferId !== this.transferId) return;
    const part = snapshotPartSchema.safeParse(message);
    if (message.snapshotPart === 'refs') {
      this.refs =
        !this.receivedRefs && part.success && part.data.snapshotPart === 'refs'
          ? part.data.refs
          : undefined;
      this.receivedRefs = true;
      return;
    }
    if (
      part.success &&
      part.data.snapshotPart === 'complete' &&
      this.refs?.length === part.data.refCount
    ) {
      return { kind: 'compactSnapshot', snapshot: { ...part.data.snapshot, refs: this.refs } };
    }
    return {
      kind: 'error',
      code: 'INVALID_SNAPSHOT',
      message:
        'The Git service returned an incomplete or invalid repository snapshot. Reopen the repository to retry.',
    };
  }
}
