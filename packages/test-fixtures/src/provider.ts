export function githubPullFixture(number = 1) {
  return {
    number,
    title: 'Review fixture',
    state: 'open',
    draft: false,
    user: { login: 'author' },
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    merged_at: null,
    head: { label: 'fork:feature', ref: 'feature', sha: '1'.repeat(40) },
    base: { label: 'team:main', ref: 'main', sha: '2'.repeat(40) },
    body: 'A change to review',
    merged: false,
    mergeable: true,
    mergeable_state: 'clean',
    commits: 1,
    comments: 0,
    review_comments: 0,
    changed_files: 2,
    additions: 1,
    deletions: 1,
  };
}
