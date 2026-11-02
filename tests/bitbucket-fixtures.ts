export const bitbucketRepositoryFixture = {
  uuid: '{20000000-0000-4000-8000-000000000001}',
  full_name: 'team/project',
};
export const bitbucketUserFixture = {
  uuid: '{10000000-0000-4000-8000-000000000001}',
  display_name: 'Fixture Person',
};
export function bitbucketPullFixture(id = 1) {
  return {
    id,
    title: `Pull ${id}`,
    summary: { raw: 'Literal <script>description</script>', html: '<b>Ignored</b>' },
    state: 'OPEN',
    draft: false,
    queued: false,
    author: bitbucketUserFixture,
    source: {
      repository: { uuid: '{20000000-0000-4000-8000-000000000002}', full_name: 'contributor/fork' },
      branch: { name: 'feature' },
      commit: { hash: '1'.repeat(40) },
    },
    destination: {
      repository: bitbucketRepositoryFixture,
      branch: { name: 'main' },
      commit: { hash: '2'.repeat(40) },
    },
    created_on: '2026-10-01T12:00:00+00:00',
    updated_on: '2026-10-02T12:00:00+00:00',
    merge_commit: null,
    comment_count: 5,
    task_count: 2,
    close_source_branch: true,
    closed_by: null,
    reason: '',
    reviewers: [bitbucketUserFixture],
    participants: [
      {
        user: bitbucketUserFixture,
        role: 'REVIEWER',
        approved: false,
        state: 'changes_requested',
        participated_on: '2026-10-02T12:00:00+00:00',
      },
    ],
    links: { html: { href: 'https://attacker.test/ignored' } },
  };
}
