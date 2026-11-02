import type { Octokit } from '@octokit/rest';
import {
  providerPullTemplatesSchema,
  providerBranchNameSchema,
  type ProviderPullTemplatesOptions,
  type ProviderPullTemplateOptions,
} from '@openkraken/ipc-contract';
import { ProviderError } from './provider-error.js';
type Repository = ProviderPullTemplatesOptions['repository'];
type Entry = { path: string; mode: string; type: string; sha: string; size?: number };
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const regular = (entry: Entry) =>
  entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
const directory = (entry: Entry) => entry.type === 'tree' && entry.mode === '040000';
const invalid = () =>
  new ProviderError(
    'PROVIDER_TEMPLATE',
    'The provider template is missing, invalid or exceeds the supported size.',
  );
async function tree(
  client: Octokit,
  headers: Record<string, string>,
  repo: Repository,
  sha: string,
) {
  if (!oid.test(sha)) throw invalid();
  const { data } = await client.git.getTree({
    headers,
    owner: repo.owner,
    repo: repo.name,
    tree_sha: sha,
  });
  if (
    data.sha !== sha ||
    typeof data.truncated !== 'boolean' ||
    !Array.isArray(data.tree) ||
    data.tree.some(
      (entry) =>
        typeof entry.path !== 'string' ||
        !entry.path ||
        entry.path === '.' ||
        entry.path === '..' ||
        /[/\\]/.test(entry.path) ||
        [...entry.path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        typeof entry.sha !== 'string' ||
        !oid.test(entry.sha) ||
        typeof entry.type !== 'string' ||
        typeof entry.mode !== 'string' ||
        (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0)),
    )
  )
    throw invalid();
  return { entries: data.tree as Entry[], truncated: data.truncated };
}
async function rootTree(
  client: Octokit,
  headers: Record<string, string>,
  repo: Repository,
  revision: string,
) {
  const { data } = await client.git.getCommit({
    headers,
    owner: repo.owner,
    repo: repo.name,
    commit_sha: revision,
  });
  if (data.sha !== revision || typeof data.tree?.sha !== 'string' || !oid.test(data.tree.sha))
    throw invalid();
  return data.tree.sha;
}
export async function loadPullTemplates(
  client: Octokit,
  headers: Record<string, string>,
  options: ProviderPullTemplatesOptions,
) {
  const repo = options.repository;
  const { data: metadata } = await client.repos.get({
    headers,
    owner: repo.owner,
    repo: repo.name,
  });
  const branch = providerBranchNameSchema.safeParse(metadata.default_branch);
  if (!branch.success) throw invalid();
  const { data } = await client.repos.getBranch({
    headers,
    owner: repo.owner,
    repo: repo.name,
    branch: branch.data,
  });
  if (
    data.name !== branch.data ||
    typeof data.commit?.sha !== 'string' ||
    !oid.test(data.commit.sha)
  )
    throw invalid();
  const revision = data.commit.sha;
  const root = await tree(client, headers, repo, await rootTree(client, headers, repo, revision));
  let limited = root.truncated;
  const templates: { path: string; sha: string; size: number }[] = [];
  const add = (prefix: string, entry: Entry) => {
    if (!regular(entry)) return;
    if (!Number.isSafeInteger(entry.size) || entry.size! < 0) throw invalid();
    if (templates.length >= 50) {
      limited = true;
      return;
    }
    templates.push({ path: `${prefix}${entry.path}`, sha: entry.sha, size: entry.size! });
  };
  const inspect = async (prefix: string, entries: Entry[]) => {
    for (const entry of entries) {
      if (/^pull_request_template(?:\.(?:md|txt))?$/i.test(entry.path) && regular(entry))
        add(prefix, entry);
    }
    const folders = entries.filter(
      (entry) => /^pull_request_template$/i.test(entry.path) && directory(entry),
    );
    // Bound discovery to one template directory per supported location.
    limited ||= folders.length > 1;
    const folder = folders.find((entry) => entry.path === 'PULL_REQUEST_TEMPLATE') ?? folders[0];
    if (folder) {
      const nested = await tree(client, headers, repo, folder.sha);
      limited ||= nested.truncated;
      for (const file of nested.entries) add(`${prefix}${folder.path}/`, file);
    }
  };
  await inspect('', root.entries);
  for (const folder of ['.github', 'docs']) {
    const entry = root.entries.find((item) => item.path === folder && directory(item));
    if (!entry) continue;
    const child = await tree(client, headers, repo, entry.sha);
    limited ||= child.truncated;
    await inspect(`${folder}/`, child.entries);
  }
  return providerPullTemplatesSchema.parse({
    defaultBranch: branch.data,
    revision,
    templates,
    limited,
  });
}
export async function loadPullTemplate(
  client: Octokit,
  headers: Record<string, string>,
  options: ProviderPullTemplateOptions,
) {
  let sha = await rootTree(client, headers, options.repository, options.revision);
  const parts = options.path.split('/');
  let selected: Entry | undefined;
  for (let i = 0; i < parts.length; i++) {
    const listing = await tree(client, headers, options.repository, sha);
    selected = listing.entries.find((entry) => entry.path === parts[i]);
    if (!selected || (i < parts.length - 1 && !directory(selected))) throw invalid();
    sha = selected.sha;
  }
  if (!selected || !regular(selected) || selected.size === undefined || selected.size > 65536)
    throw invalid();
  const { data } = await client.git.getBlob({
    headers,
    owner: options.repository.owner,
    repo: options.repository.name,
    file_sha: selected.sha,
  });
  if (
    data.sha !== selected.sha ||
    data.encoding !== 'base64' ||
    data.size !== selected.size ||
    typeof data.content !== 'string' ||
    data.content.length > 100000
  )
    throw invalid();
  const encoded = data.content.replace(/[\r\n]/g, '');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== selected.size || bytes.toString('base64') !== encoded) throw invalid();
  try {
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (body.includes('\0')) throw invalid();
    return { body };
  } catch {
    throw invalid();
  }
}
