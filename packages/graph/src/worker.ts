import { GraphEngine } from './engine.js';
import type { GraphRequest } from './engine.js';
const engine = new GraphEngine(true);
let indexing = false;
function indexChunk() {
  if (engine.indexPending(25)) setTimeout(indexChunk, 0);
  else indexing = false;
}
self.onmessage = (event: MessageEvent<GraphRequest>) => {
  self.postMessage(engine.handle(event.data));
  // Let the layout reply reach the UI before building the new search documents.
  if (event.data.method !== 'search' && !indexing) {
    indexing = true;
    setTimeout(indexChunk, 0);
  }
};
