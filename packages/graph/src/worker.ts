import { GraphEngine } from './engine.js';
import type { GraphRequest } from './engine.js';
import { packLayout } from './layout-message.js';
const engine = new GraphEngine(true);
let indexing = false;
function indexChunk() {
  if (engine.indexPending(25)) setTimeout(indexChunk, 0);
  else indexing = false;
}
self.onmessage = (event: MessageEvent<GraphRequest>) => {
  const response = engine.handle(event.data);
  if (response.kind === 'layout') {
    const packed = packLayout(response);
    self.postMessage(packed, { transfer: [packed.nodes.buffer, packed.edges.buffer] });
  } else self.postMessage(response);
  // Let the layout reply reach the UI before building the new search documents.
  if (event.data.method !== 'search' && !indexing) {
    indexing = true;
    setTimeout(indexChunk, 0);
  }
};
