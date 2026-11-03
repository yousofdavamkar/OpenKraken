# This is the rcfile of an interactive, non-login Bash started by OpenKraken.
# Read the user's configuration first, as Bash would without --rcfile.
if [[ -r "$HOME/.bashrc" ]]; then
  builtin source "$HOME/.bashrc"
fi

__openkraken_install_integration() {
  # PS0 needs Bash 4.4; array PROMPT_COMMAND needs Bash 5.1. Older shells and
  # incompatible prompt settings keep their normal behavior without integration.
  if (( BASH_VERSINFO[0] < 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] < 1) )); then
    return 0
  fi
  [[ $- == *i* ]] || return 0
  builtin shopt -q promptvars || return 0
  local variable
  for variable in PS0 PS1 PROMPT_COMMAND; do
    if [[ $(builtin declare -p "$variable" 2>/dev/null) =~ ^declare\ -[^[:space:]]*r ]]; then
      return 0
    fi
  done

  __openkraken_prompt_start=''
  __openkraken_prompt_end='\[\e]133;B\a\]'
  __openkraken_prompt_seen=0
  __openkraken_prompt() {
    # Prompt tools can replace PS1 each time. Remove only our own previous
    # wrapper, then wrap the current prompt without evaluating any of its text.
    if [[ $PS1 == "$__openkraken_prompt_start"*"$__openkraken_prompt_end" ]]; then
      PS1=${PS1#"$__openkraken_prompt_start"}
      PS1=${PS1%"$__openkraken_prompt_end"}
    fi
    __openkraken_prompt_start='\[\e]133;A\a\]'
    if (( __openkraken_prompt_seen )); then
      # Bash restores the command's $? and PIPESTATUS before expanding PS1.
      # Sampling here leaves the user's PROMPT_COMMAND and DEBUG hooks first.
      __openkraken_prompt_start='\[$(builtin printf "\033]133;D;%s\007" "$?")\e]133;A\a\]'
    fi
    __openkraken_prompt_seen=1
    PS1="$__openkraken_prompt_start$PS1$__openkraken_prompt_end"
  }
  PS0="${PS0-}"$'\e]133;C\a'
  if [[ $(builtin declare -p PROMPT_COMMAND 2>/dev/null) =~ ^declare\ -[^[:space:]]*a ]]; then
    PROMPT_COMMAND+=(__openkraken_prompt)
  else
    # A newline also preserves a scalar ending in a comment or semicolon.
    PROMPT_COMMAND="${PROMPT_COMMAND-}"$'\n__openkraken_prompt'
  fi
}
__openkraken_install_integration
unset -f __openkraken_install_integration
