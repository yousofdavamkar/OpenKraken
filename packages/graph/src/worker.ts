import { allocateLanes } from './index.js';
import type { GraphCommit, Checkpoint } from './index.js';
self.onmessage = (
  event: MessageEvent<{ id: number; commits: GraphCommit[]; checkpoint?: Checkpoint }>,
) => {
  self.postMessage({
    id: event.data.id,
    ...allocateLanes(event.data.commits, event.data.checkpoint),
  });
};
