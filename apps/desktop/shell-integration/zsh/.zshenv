# The host redirects only this interactive shell's startup, never user files.
[[ ${OPENKRAKEN_ZSH_ZDOTDIR_SET-} == [01] ]] || return 0
__openkraken_zsh_directory=$ZDOTDIR
if [[ $OPENKRAKEN_ZSH_ZDOTDIR_SET == 1 ]]; then
  ZDOTDIR=$OPENKRAKEN_ZSH_ZDOTDIR
else
  builtin unset ZDOTDIR
fi
builtin unset OPENKRAKEN_ZSH_ZDOTDIR_SET OPENKRAKEN_ZSH_ZDOTDIR

# Source at top level: typeset and option changes retain their normal scope.
if [[ -r ${ZDOTDIR-$HOME}/.zshenv ]]; then
  builtin source "${ZDOTDIR-$HOME}/.zshenv"
fi
if [[ -o rcs && -o interactive && ${(t)ZDOTDIR} != *readonly* ]]; then
  __openkraken_zsh_user_directory_set=${+ZDOTDIR}
  __openkraken_zsh_user_directory=${ZDOTDIR-}
  ZDOTDIR=$__openkraken_zsh_directory
else
  builtin unset __openkraken_zsh_directory
fi
return 0
