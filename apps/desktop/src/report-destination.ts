export function reportDestination(raw: string | null) {
  if (raw === null) return null;
  const url = new URL(raw);
  const parts = url.pathname.split('/').filter(Boolean);
  const project = parts.pop();
  if (
    raw.length > 2048 ||
    url.protocol !== 'https:' ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[a-f0-9]{32}$/.test(url.username) ||
    !/^\d{1,30}$/.test(project ?? '') ||
    parts.some((part) => !/^[a-zA-Z0-9_-]+$/.test(part))
  )
    throw new Error(
      'Crash reporting requires an HTTPS Sentry DSN with a public key and project ID',
    );
  const endpoint = new URL(url);
  endpoint.username = '';
  endpoint.pathname = `/${[...parts, 'api', project, 'envelope', ''].join('/')}`;
  return { dsn: url.href, endpoint: endpoint.href, destination: endpoint.origin };
}
