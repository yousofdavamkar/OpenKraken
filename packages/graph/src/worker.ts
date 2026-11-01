import { GraphEngine } from './engine.js';
import type { GraphRequest } from './engine.js';
const engine = new GraphEngine();
self.onmessage = (event: MessageEvent<GraphRequest>) => {
  self.postMessage(engine.handle(event.data));
};
