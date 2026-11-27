import { describe, expect, it } from 'vitest';
import {
  bitbucketPullFixture,
  bitbucketRepositoryFixture,
} from '../../tests/bitbucket-fixtures.js';
import { loadBitbucketMergeability } from './src/bitbucket-mergeability.js';
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
function fixture(
  body: unknown,
  after = pull,
  expectedPath = statuses + '?page=1&pagelen=100&sort=key',
) {
  let reads = 0;
  const read: BitbucketRead = async (path, parse) => {
    if (path === repo) return parse(bitbucketRepositoryFixture);
    if (path === pr) return parse(reads++ === 0 ? pull : after);
    expect(path).toEqual(expectedPath);
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

describe('Bitbucket mergeability checks', () => {
  const mergeOptions = {
    repository,
    number: 1,
    repositoryId: pull.destination.repository.uuid,
    source: options.source,
    destination: {
      repository: { ...repository, id: pull.destination.repository.uuid },
      branch: 'main',
      commit: pull.destination.commit.hash,
    },
  };
  const read = (body: unknown, after = pull) => fixture(body, after, pr + '/mergeability/checks');
  const advisory = {
    type: 'standard_merge_check',
    status: 'FAILED',
    required: false,
    blocking: false,
    check: { kind: 'minimum_approvals' },
  };
  it('preserves failed advisory and unknown required checks without inferring a merge decision', async () => {
    const waiting = {
      type: 'custom_on_merge_check',
      status: 'UNKNOWN',
      blocking: true,
      required: true,
      check: { name: 'Deployment' },
      message: 'Waiting for review',
    };
    expect(
      await loadBitbucketMergeability(read({ size: 2, values: [advisory, waiting] }), mergeOptions),
    ).toEqual([
      {
        type: advisory.type,
        status: 'FAILED',
        required: false,
        blocking: false,
        name: 'minimum_approvals',
        detail: null,
      },
      {
        type: waiting.type,
        status: 'UNKNOWN',
        required: true,
        blocking: true,
        name: 'Deployment',
        detail: 'Waiting for review',
      },
    ]);
  });
  it('discards results after a destination move even with an unchanged source', async () => {
    const after = { ...pull, destination: { ...pull.destination, commit: { hash: 'abc1234' } } };
    await expect(
      loadBitbucketMergeability(read({ values: [] }, after), mergeOptions),
    ).rejects.toMatchObject({ code: 'STALE_PROVIDER_MERGE' });
  });
  it.each([{ size: 2, values: [advisory] }, { values: [{ ...advisory, blocking: undefined }] }])(
    'rejects incomplete checks',
    async (body) => {
      await expect(loadBitbucketMergeability(read(body), mergeOptions)).rejects.toThrow();
    },
  );
});
