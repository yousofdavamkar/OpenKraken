import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { DesktopApi, Request, Snapshot } from '@openkraken/ipc-contract';
declare global {
  interface Window {
    openkraken: DesktopApi;
  }
}
interface State {
  snapshot?: Snapshot;
  busy?: string;
  error?: string;
  run: (request: Request) => Promise<void>;
  cancel: () => Promise<void>;
}
export const useRepository = create<State>()(
  immer((set, get) => ({
    run: async (request) => {
      if (get().busy) return;
      performance.mark('repository-open-start');
      set((state) => {
        state.busy = request.id;
        state.error = undefined;
      });
      try {
        const result = await window.openkraken.request(request);
        performance.mark('repository-response');
        if (get().busy !== request.id) return;
        set((state) => {
          if (result.kind === 'snapshot') state.snapshot = result.snapshot;
          if (result.kind === 'error') state.error = result.message;
        });
        performance.mark('repository-state');
      } catch (error) {
        set((state) => {
          state.error = error instanceof Error ? error.message : String(error);
        });
      } finally {
        set((state) => {
          if (state.busy === request.id) state.busy = undefined;
        });
      }
    },
    cancel: async () => {
      const id = get().busy;
      if (id) await window.openkraken.cancel(id);
    },
  })),
);
