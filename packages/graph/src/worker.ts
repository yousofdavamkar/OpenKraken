import { GraphEngine } from './engine.js';
import type { GraphRequest } from './engine.js';
const engine = new GraphEngine();
self.onmessage = (event: MessageEvent<GraphRequest>) => {
  self.postMessage(engine.handle(event.data));
  // Let the layout reply reach the UI before building the new search documents.
  if (event.data.method !== 'search') setTimeout(() => engine.indexPending(), 0);
};
