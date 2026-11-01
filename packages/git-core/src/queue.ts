import { GitError } from './runner.js';
type Job = { write: boolean; start: () => void; cancel: () => void; signal?: AbortSignal };
/** FIFO writers cannot be starved by later readers. Queues are scoped to common git dir. */
export class RepositoryQueue {
  private jobs: Job[] = [];
  private readers = 0;
  private writing = false;
  constructor(private readLimit = 4) {}
  run<T>(write: boolean, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const at = this.jobs.indexOf(job);
        if (at >= 0) this.jobs.splice(at, 1);
        reject(new GitError('CANCELLED', 'Operation cancelled'));
        this.pump();
      };
      const job: Job = {
        write,
        signal,
        cancel,
        start: () => {
          signal?.removeEventListener('abort', cancel);
          if (write) this.writing = true;
          else this.readers++;
          Promise.resolve()
            .then(() => {
              if (signal?.aborted) throw new GitError('CANCELLED', 'Operation cancelled');
              return work();
            })
            .then(resolve, reject)
            .finally(() => {
              if (write) this.writing = false;
              else this.readers--;
              this.pump();
            });
        },
      };
      if (signal?.aborted) {
        reject(new GitError('CANCELLED', 'Operation cancelled'));
        return;
      }
      signal?.addEventListener('abort', cancel, { once: true });
      this.jobs.push(job);
      this.pump();
    });
  }
  private pump() {
    if (this.writing) return;
    while (this.jobs.length) {
      const next = this.jobs[0]!;
      if (next.write ? this.readers > 0 : this.readers >= this.readLimit) return;
      this.jobs.shift();
      next.start();
      if (next.write) return;
    }
  }
}
