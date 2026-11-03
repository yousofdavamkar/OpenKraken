[[ ${__openkraken_zsh_directory-} == ${ZDOTDIR-} ]] || return 0
if [[ $__openkraken_zsh_user_directory_set == 1 ]]; then
  ZDOTDIR=$__openkraken_zsh_user_directory
else
  builtin unset ZDOTDIR
fi
builtin unset __openkraken_zsh_directory __openkraken_zsh_user_directory_set __openkraken_zsh_user_directory
if [[ -r ${ZDOTDIR-$HOME}/.zshrc ]]; then
  builtin source "${ZDOTDIR-$HOME}/.zshrc"
fi

# Preserve intentionally incompatible prompt settings instead of changing them.
[[ -o interactive && -o promptpercent ]] || return 0
__openkraken_zsh_install() {
  emulate -L zsh
  local variable
  for variable in PROMPT precmd_functions preexec_functions; do
    [[ ${(tP)variable} != *readonly* ]] || return 0
  done
  (( ! ${+functions[__openkraken_zsh_prompt]} && ! ${+functions[__openkraken_zsh_preexec]} )) || return 0
  typeset -g __openkraken_zsh_prompt_start=''
  typeset -g __openkraken_zsh_prompt_end=$'%{\e]133;B\a%}'
  typeset -gi __openkraken_zsh_prompt_seen=0
  __openkraken_zsh_prompt() {
    emulate -L zsh
    if [[ $PROMPT == "$__openkraken_zsh_prompt_start"*"$__openkraken_zsh_prompt_end" ]]; then
      PROMPT=${PROMPT#"$__openkraken_zsh_prompt_start"}
      PROMPT=${PROMPT%"$__openkraken_zsh_prompt_end"}
    fi
    __openkraken_zsh_prompt_start=$'%{\e]133;A\a%}'
    if (( __openkraken_zsh_prompt_seen )); then
      # Zsh expands %? with the command status without evaluating shell code.
      __openkraken_zsh_prompt_start=$'%{\e]133;D;%?\a\e]133;A\a%}'
    fi
    __openkraken_zsh_prompt_seen=1
    PROMPT="$__openkraken_zsh_prompt_start$PROMPT$__openkraken_zsh_prompt_end"
  }
  __openkraken_zsh_preexec() {
    builtin printf '\033]133;C\007'
  }
  typeset -ga precmd_functions preexec_functions
  precmd_functions+=(__openkraken_zsh_prompt)
  preexec_functions+=(__openkraken_zsh_preexec)
}
__openkraken_zsh_install
builtin unfunction __openkraken_zsh_install
return 0
