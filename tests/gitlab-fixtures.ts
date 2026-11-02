export function gitlabMergeFixture(iid = 1) {
  return {
    id: 1000 + iid,
    iid,
    project_id: 77,
    target_project_id: 77,
    source_project_id: 88,
    title: `Merge ${iid}`,
    description: 'Literal <script>description</script>',
    state: 'opened',
    draft: false,
    author: { id: 12, username: 'contributor' },
    created_at: '2026-10-01T12:00:00Z',
    updated_at: '2026-10-02T12:00:00Z',
    merged_at: null,
    source_branch: 'feature',
    target_branch: 'main',
    sha: '1'.repeat(40),
    diff_refs: { base_sha: '2'.repeat(40), head_sha: '1'.repeat(40), start_sha: '3'.repeat(40) },
    detailed_merge_status: 'checking',
    has_conflicts: false,
    changes_count: '1000+',
    user_notes_count: 5,
    web_url: 'https://attacker.test/ignored',
  };
}

export function gitlabFileFixture(path = 'src/new.ts') {
  return {
    old_path: 'src/old.ts',
    new_path: path,
    a_mode: '100644',
    b_mode: '100755',
    new_file: false,
    renamed_file: true,
    deleted_file: false,
    generated_file: false,
    collapsed: false,
    too_large: false,
    diff: '@@ -1 +1 @@\n-old\n+<script>new</script>\n',
  };
}

export function gitlabDiscussionFixture(id = 1) {
  return {
    id: id.toString(16).padStart(40, '0'),
    individual_note: false,
    notes: [
      {
        id: id * 10,
        type: 'DiffNote',
        body: 'Literal <script>discussion</script>',
        author: { username: 'reviewer' },
        created_at: '2026-10-01T12:00:00Z',
        updated_at: '2026-10-02T12:00:00Z',
        system: false,
        noteable_id: 1007,
        noteable_type: 'MergeRequest',
        project_id: 77,
        noteable_iid: null,
        resolvable: true,
        resolved: false,
        resolved_by: null,
        resolved_at: null,
        position: {
          position_type: 'text',
          base_sha: '2'.repeat(40),
          head_sha: '1'.repeat(40),
          start_sha: '3'.repeat(40),
          old_path: 'old.ts',
          new_path: 'new.ts',
          old_line: null,
          new_line: 12,
        },
      },
    ],
  };
}

export function gitlabIssueFixture(iid = 1) {
  return {
    id: 2000 + iid,
    iid,
    project_id: 77,
    title: `Issue ${iid}`,
    description: 'Literal <script>issue</script>',
    state: 'opened',
    author: { id: 12, username: 'contributor' },
    labels: ['bug', 'triage'],
    assignees: [{ id: 13, username: 'maintainer' }],
    milestone: { id: 4, title: 'Next release' },
    created_at: '2026-10-01T12:00:00Z',
    updated_at: '2026-10-02T12:00:00Z',
    closed_at: null,
    user_notes_count: 5,
    confidential: true,
    discussion_locked: null,
    issue_type: 'incident',
    due_date: '2026-11-10',
    weight: 3,
    web_url: 'https://attacker.test/ignored',
  };
}
export function gitlabIssueNoteFixture(id = 1, iid = 7) {
  return {
    id,
    body: 'Literal <script>note</script>',
    author: { username: 'reviewer' },
    created_at: '2026-10-01T12:00:00Z',
    updated_at: '2026-10-02T12:00:00Z',
    system: false,
    noteable_id: 2000 + iid,
    noteable_iid: iid,
    noteable_type: 'Issue',
    project_id: 77,
    internal: true,
    confidential: true,
    type: 'DiscussionNote',
  };
}
