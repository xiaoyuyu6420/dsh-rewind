#!/bin/sh
# Install / uninstall the dsh-rewind plugin in the DSH Desktop profile.
#
# Usage:
#   ./install.sh            # install as a linked (dev) plugin
#   ./install.sh --uninstall
#
# The plugin is installed with a `link:` dependency so edits in this folder take
# effect on the next DSH restart (no copy step). Quit DeepSeek Harness first for
# a clean restart; the command itself only edits the profile package.json.
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

dsh_cli=${DSH_CLI:-}
if [ -z "$dsh_cli" ]; then
  for candidate in \
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
    "$HOME/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  do
    if [ -x "$candidate" ]; then dsh_cli=$candidate; break; fi
  done
fi
if [ -z "$dsh_cli" ] && command -v dsh >/dev/null 2>&1; then dsh_cli=$(command -v dsh); fi
if [ -z "$dsh_cli" ]; then
  echo "dsh-rewind: cannot find the dsh CLI." >&2
  echo "Set DSH_CLI=/path/to/dsh or install the CLI, then retry." >&2
  exit 1
fi

action=install
if [ "${1:-}" = "--uninstall" ] || [ "${1:-}" = "uninstall" ]; then action=uninstall; fi

echo "dsh-rewind: using CLI: $dsh_cli"
if [ "$action" = uninstall ]; then
  "$dsh_cli" plugin --profile desktop remove @local/dsh-rewind
  echo "dsh-rewind: removed from the desktop profile. Restart DeepSeek Harness to apply."
else
  "$dsh_cli" plugin --profile desktop add "link:$repo"
  echo "dsh-rewind: installed (linked). Restart DeepSeek Harness, then reload the page."
  echo "dsh-rewind: this folder is now the live source for the plugin."
fi
