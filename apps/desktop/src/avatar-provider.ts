import { nativeImage, session } from 'electron';
/** Chromium networking retains system proxy/TLS behavior in an isolated, cookieless session. */
export async function fetchAvatar(hash: string, signal: AbortSignal): Promise<Buffer | null> {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid avatar hash');
  let url = new URL(`https://gravatar.com/avatar/${hash}?s=32&d=404`);
  for (let redirects = 0; redirects < 3; redirects++) {
    const response = await session.fromPartition('openkraken-avatars').fetch(url.href, {
      signal,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Missing avatar redirect');
      url = new URL(location, url);
      if (
        url.protocol !== 'https:' ||
        !['gravatar.com', 'www.gravatar.com', 'secure.gravatar.com'].includes(url.hostname) ||
        url.port ||
        url.username ||
        url.password ||
        url.pathname !== `/avatar/${hash}`
      )
        throw new Error('Invalid avatar redirect');
      continue;
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (
      !response.ok ||
      !/^image\/(png|jpeg|webp)(;|$)/.test(response.headers.get('content-type') ?? '')
    ) {
      await response.body?.cancel();
      throw new Error('Avatar unavailable');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty avatar');
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 65536) throw new Error('Avatar too large');
        chunks.push(Buffer.from(part.value));
      }
    } finally {
      await reader.cancel();
    }
    const image = nativeImage.createFromBuffer(Buffer.concat(chunks)),
      size = image.getSize();
    if (image.isEmpty() || size.width > 128 || size.height > 128)
      throw new Error('Invalid avatar dimensions');
    return image.resize({ width: 32, height: 32 }).toPNG();
  }
  throw new Error('Too many avatar redirects');
}
