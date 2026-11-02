export const commandCatalog = {
  'app.commands': {
    label: 'Command palette',
    category: 'Settings',
    keywords: 'commands actions fuzzy search',
  },
  'app.keybindings': {
    label: 'Keyboard shortcuts',
    category: 'Settings',
    keywords: 'keymap keybindings customize JSON settings',
  },
  'repository.open': {
    label: 'Open repository',
    category: 'Repository',
    keywords: 'folder browse local',
  },
  'repository.clone': {
    label: 'Clone repository',
    category: 'Repository',
    keywords: 'download remote url',
  },
  'repository.init': {
    label: 'Initialize repository',
    category: 'Repository',
    keywords: 'new git folder init',
  },
  'repository.refresh': {
    label: 'Refresh repository',
    category: 'Repository',
    keywords: 'reload status history',
  },
  'repository.remotes': {
    label: 'Manage remotes',
    category: 'Repository',
    keywords: 'fetch origin remote urls',
  },
  'repository.pull': {
    label: 'Review pull',
    category: 'Repository',
    keywords: 'fetch synchronize upstream merge',
  },
  'repository.push': {
    label: 'Review push',
    category: 'Repository',
    keywords: 'publish upload upstream',
  },
  'references.branch': {
    label: 'Create branch',
    category: 'References',
    keywords: 'new branch selected commit',
  },
  'references.tag': {
    label: 'Create tag',
    category: 'References',
    keywords: 'new annotated signed tag',
  },
  'history.search': {
    label: 'Search commits',
    category: 'History',
    keywords: 'find log commit author message hash',
  },
  'history.integrate': {
    label: 'Integrate commits',
    category: 'History',
    keywords: 'merge rebase cherry pick revert',
  },
  'history.rebase': {
    label: 'Interactive rebase',
    category: 'History',
    keywords: 'reorder squash fixup edit drop',
  },
  'history.reset': {
    label: 'Review reset',
    category: 'History',
    keywords: 'soft mixed hard reset',
  },
  'worktree.stashes': {
    label: 'Manage stashes',
    category: 'Working tree',
    keywords: 'stash save apply pop',
  },
  'worktree.undo': {
    label: 'Undo repository change',
    category: 'Working tree',
    keywords: 'undo restore journal',
  },
  'worktree.redo': {
    label: 'Redo repository change',
    category: 'Working tree',
    keywords: 'redo journal',
  },
  'providers.accounts': {
    label: 'Provider accounts',
    category: 'Integrations',
    keywords: 'github gitlab bitbucket authentication token',
  },
  'providers.pulls': {
    label: 'Browse pull requests',
    category: 'Integrations',
    keywords: 'merge requests review collaboration',
  },
  'providers.issues': {
    label: 'Browse issues',
    category: 'Integrations',
    keywords: 'issue tracker tickets',
  },
} as const;
export type CommandId = keyof typeof commandCatalog;
export const commandIds = Object.keys(commandCatalog) as CommandId[];
export function isCommandId(value: string): value is CommandId {
  return Object.hasOwn(commandCatalog, value);
}
