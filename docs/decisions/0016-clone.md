# 0016 — Clone into an explicitly selected empty folder

Clone accepts a repository URL or absolute local path, an optional branch/tag, a depth limit, on-demand blobs (`blob:none`), and optional cone-mode sparse directories. The native folder chooser supplies the destination; the renderer never supplies an arbitrary destination path. The service canonicalizes it, requires it to be empty, serializes work for that path, runs native clone and registers/opens the repository only after success.

Local sources use a file URL when depth/filter options are selected so Git does not silently ignore those options through its local-copy shortcut. Sparse directories use C-style quoted, newline-delimited stdin, with repository-relative directory validation. Empty sparse selection means root files only; cone mode also includes files alongside selected directories and their ancestors. Submodules are not recursively cloned.

Clone and subsequent sparse materialization use the existing transport boundary: TLS verification, restricted protocols, credential masking, native helper/agent access, bounded progress and process-group cancellation. The Git operations have a 30-minute bound and the desktop request a 31-minute bound. Cancellation/failure does not register the incomplete repository. The application does not recursively delete the selected folder; Git performs its native cleanup. If sparse setup fails after cloning, the repository can remain available in that folder for manual opening/recovery.

Tests cover shallow/sparse/blob-filtered local remotes, selected branches, root-only sparse mode, active HTTP transport cancellation, native progress, nonempty destination protection and desktop clone-to-history navigation.

References: [Git clone](https://git-scm.com/docs/git-clone), [Git sparse-checkout](https://git-scm.com/docs/git-sparse-checkout).
