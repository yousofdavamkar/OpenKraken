import { snapshotPartSchema, type ServiceResult } from '@openkraken/ipc-contract';

/** Main keeps the validated refs private until the same opening supplies its complete snapshot. */
export class SnapshotTransfer {
  private references?: Exclude<
    ReturnType<typeof snapshotPartSchema.parse>,
    { snapshotPart: 'complete' }
  >;
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
    if (message.snapshotPart === 'refs' || message.snapshotPart === 'tagAliases') {
      this.references =
        !this.receivedRefs && part.success && part.data.snapshotPart !== 'complete'
          ? part.data
          : undefined;
      this.receivedRefs = true;
      return;
    }
    const references = this.references;
    if (
      part.success &&
      part.data.snapshotPart === 'complete' &&
      references?.refs.length === part.data.refCount
    ) {
      if (references.snapshotPart === 'tagAliases')
        return { kind: 'snapshot', snapshot: { ...part.data.snapshot, refs: references.refs } };
      return {
        kind: 'compactSnapshot',
        snapshot: { ...part.data.snapshot, refs: references.refs },
      };
    }
    return {
      kind: 'error',
      code: 'INVALID_SNAPSHOT',
      message:
        'The Git service returned an incomplete or invalid repository snapshot. Reopen the repository to retry.',
    };
  }
}
