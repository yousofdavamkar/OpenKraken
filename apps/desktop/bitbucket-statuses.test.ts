import { describe, expect, it } from 'vitest';
import {
  bitbucketPullFixture,
  bitbucketRepositoryFixture,
} from '../../tests/bitbucket-fixtures.js';
import { loadBitbucketStatuses } from './src/bitbucket-statuses.js';
import type { BitbucketRead } from './src/bitbucket-pulls.js';

const pull = bitbucketPullFixture();
const repository = { owner: 'team', name: 'project' };
const options = {
  repository,
  number: 1,
  repositoryId: bitbucketRepositoryFixture.uuid,
  source: {
    repository: { id: pull.source.repository.uuid, owner: 'contributor', name: 'fork' },
    branch: 'feature',
    commit: pull.source.commit.hash,
  },
  page: 1,
};
const repo = 'repositories/team/project';
const pr = repo + '/pullrequests/1';
const statuses = pr + '/statuses';
function fixture(body: unknown, after = pull) {
  let reads = 0;
  const read: BitbucketRead = async (path, parse) => {
    if (path === repo) return parse(bitbucketRepositoryFixture);
    if (path === pr) return parse(reads++ === 0 ? pull : after);
    expect(path).toEqual(statuses + '?page=1&pagelen=100&sort=key');
    return parse(body);
  };
  return read;
}
describe('Bitbucket pull-request build results', () => {
  it('returns a bounded status page without exposing provider URLs', async () => {
    const states = ['INPROGRESS', 'SUCCESSFUL', 'FAILED', 'STOPPED'];
    const values = states.map((state, i) => ({
      key: 'ci' + i,
      state,
      refname: 'feature',
      url: 'https://ci.invalid',
    }));
    const page = await loadBitbucketStatuses(
      fixture({ values, page: 1, next: 'https://api.bitbucket.org/2.0/' + statuses + '?page=2' }),
      options,
    );
    expect(page).toEqual({
      statuses: states.map((state, i) => ({
        key: 'ci' + i,
        state,
        refname: 'feature',
        name: '',
        description: '',
        updatedAt: null,
      })),
      nextPage: 2,
      limited: false,
    });
  });
  it('discards a completed read when the fork head changed', async () => {
    const changed = { ...pull, source: { ...pull.source, commit: { hash: 'abc1234' } } };
    await expect(
      loadBitbucketStatuses(fixture({ values: [] }, changed), options),
    ).rejects.toMatchObject({ code: 'STALE_PROVIDER_MERGE' });
  });
  it.each([
    { values: [{ key: 'build', state: 'PASSED' }] },
    { values: Array(101).fill({ key: 'build', state: 'FAILED' }) },
    { values: [], next: 'https://ci.invalid/?page=2' },
  ])('rejects malformed or oversized status pages', async (body) => {
    await expect(loadBitbucketStatuses(fixture(body), options)).rejects.toThrow();
  });
});
