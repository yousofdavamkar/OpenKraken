import { expect, test, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), decode: vi.fn() }));
vi.mock('electron', () => ({
  session: { fromPartition: () => ({ fetch: mocks.fetch }) },
  nativeImage: { createFromBuffer: mocks.decode },
}));
import { fetchAvatar } from './src/avatar-provider.js';
const hash = 'a'.repeat(64),
  signal = new AbortController().signal;
beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.decode.mockReset();
});
test('provider permits only HTTPS Gravatar redirects and never accepts caller-supplied URLs', async () => {
  mocks.fetch
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: `https://secure.gravatar.com/avatar/${hash}?s=32&d=404` },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 404 }));
  expect(await fetchAvatar(hash, signal)).toBeNull();
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  for (const location of [
    'http://gravatar.com/avatar/' + hash,
    'https://evil.test/avatar/' + hash,
    'https://user:password@gravatar.com/avatar/' + hash,
  ]) {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
    await expect(fetchAvatar(hash, signal)).rejects.toThrow('Invalid avatar redirect');
  }
  await expect(fetchAvatar('../private', signal)).rejects.toThrow('Invalid avatar hash');
});
test('provider bounds responses, rejects active content, and returns normalized PNGs', async () => {
  mocks.fetch.mockResolvedValueOnce(
    new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
  );
  await expect(fetchAvatar(hash, signal)).rejects.toThrow('Avatar unavailable');
  mocks.fetch.mockResolvedValueOnce(
    new Response(new Uint8Array(65537), { headers: { 'content-type': 'image/png' } }),
  );
  await expect(fetchAvatar(hash, signal)).rejects.toThrow('Avatar too large');
  expect(mocks.decode).not.toHaveBeenCalled();
  const output = Buffer.from('normalized');
  mocks.decode.mockReturnValue({
    getSize: () => ({ width: 32, height: 32 }),
    isEmpty: () => false,
    resize: () => ({ toPNG: () => output }),
  });
  mocks.fetch.mockResolvedValueOnce(
    new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }),
  );
  expect(await fetchAvatar(hash, signal)).toBe(output);
  expect(mocks.fetch.mock.lastCall?.[1]).toMatchObject({
    signal,
    credentials: 'omit',
    redirect: 'manual',
  });
});
