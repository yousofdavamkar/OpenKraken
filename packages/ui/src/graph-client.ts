import GraphWorker from '@openkraken/graph/worker?worker';
import type { GraphRequest, GraphResponse } from '@openkraken/graph/engine';
type Input = GraphRequest extends infer R
  ? R extends GraphRequest
    ? Omit<R, 'id'>
    : never
  : never;
export class GraphClient {
  private worker = new GraphWorker();
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (response: GraphResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor() {
    this.worker.onmessage = (event: MessageEvent<GraphResponse>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      clearTimeout(pending.timer);
      if (event.data.kind === 'error') pending.reject(new Error(event.data.message));
      else pending.resolve(event.data);
    };
    this.worker.onerror = (event) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(event.message || 'Graph worker failed'));
      }
      this.pending.clear();
    };
  }
  close() {
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Graph generation replaced'));
    }
    this.pending.clear();
  }
  request(input: Input): Promise<GraphResponse> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Graph worker timed out'));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ ...input, id });
    });
  }
}
