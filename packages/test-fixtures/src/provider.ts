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

export function githubCommentFixture(id = 10) {
  return {
    id,
    user: { login: 'reviewer' },
    body: 'Please explain this change.',
    path: 'src/main.ts',
    diff_hunk: '@@ -2,2 +2,2 @@\n-old\n+new\n context',
    commit_id: '1'.repeat(40),
    original_commit_id: '1'.repeat(40),
    line: 2,
    original_line: 2,
    side: 'RIGHT',
    start_line: null,
    original_start_line: null,
    start_side: null,
    created_at: '2026-10-03T00:00:00Z',
    updated_at: '2026-10-03T00:00:00Z',
    pull_request_url: 'https://api.github.com/repos/team/project/pulls/1',
  };
}

export function githubIssueFixture(number = 1) {
  return {
    number,
    title: 'A bug to fix',
    state: 'open',
    state_reason: null,
    user: { login: 'author' },
    labels: [{ name: 'bug' }, 'help wanted'],
    assignees: [{ login: 'maintainer' }],
    milestone: { title: 'Next release' },
    locked: false,
    comments: 1,
    body: 'Steps to reproduce',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    closed_at: null,
    html_url: 'https://untrusted.test/ignored',
  };
}
