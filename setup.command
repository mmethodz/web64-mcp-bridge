#!/bin/sh
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Install Node.js LTS, version 22 or newer, from https://nodejs.org/' 'Then run setup again.'
  exit 1
fi
node ./setup.mjs "$@"
result=$?
if [ "$#" -eq 0 ]; then
  printf '\nPress Enter to close.'
  read -r answer
fi
exit "$result"
