import { useEffect, useState } from 'react';
import { useRepository } from './store.js';
export function GitProgress() {
  const busy = useRepository((state) => state.busy);
  const [progress, setProgress] = useState<{ id: string; text: string }>();
  useEffect(
    () =>
      window.openkraken.subscribe((event) => {
        if (event.type === 'gitProgress' && event.id === useRepository.getState().busy)
          setProgress({ id: event.id, text: event.text });
      }),
    [],
  );
  return progress && progress.id === busy ? (
    <p className="git-progress" role="status" data-testid="git-progress">
      {progress.text}
    </p>
  ) : null;
}
