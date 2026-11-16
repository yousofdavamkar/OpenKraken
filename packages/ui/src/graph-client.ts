import GraphWorker from '@openkraken/graph/worker?worker';
import type { GraphRequest, GraphResponse } from '@openkraken/graph/engine';
import { unpackLayout, type WorkerResponse } from '@openkraken/graph/layout-message';
type Input = GraphRequest extends infer R
  ? R extends GraphRequest
    ? Omit<R, 'id'>
    : never
  : never;
export class GraphClient {
  private worker = new GraphWorker();
  private sequence = 0;
  private failure?: Error;
  private pending = new Map<
    number,
    {
      resolve: (response: GraphResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      try {
        if (event.data.kind === 'error') pending.reject(new Error(event.data.message));
        else
          pending.resolve(
            event.data.kind === 'packed-layout' ? unpackLayout(event.data) : event.data,
          );
      } catch {
        // The worker may already have advanced its offset. Refresh must start a fresh layout.
        this.stop(new Error('Incomplete graph layout'));
        return;
      }
      this.pending.delete(event.data.id);
      clearTimeout(pending.timer);
    };
    this.worker.onmessageerror = () => this.stop(new Error('Graph worker reply could not be read'));
    this.worker.onerror = (event) => this.stop(new Error(event.message || 'Graph worker failed'));
  }
  get failed() {
    return this.failure !== undefined;
  }
  close() {
    this.stop(new Error('Graph generation replaced'));
  }
  private stop(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  request(input: Input): Promise<GraphResponse> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('Graph worker timed out');
        // A lost layout reply can leave the worker ahead of the displayed generation.
        if (input.method !== 'search') return this.stop(error);
        this.pending.delete(id);
        reject(error);
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ ...input, id });
      } catch (error) {
        // A synchronous clone failure never reaches the worker or advances its generation.
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}
