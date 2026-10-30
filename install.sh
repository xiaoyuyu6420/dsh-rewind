#!/bin/sh
# dsh-rewind installer — installs the plugin the normal way (npm / GitHub /
# local tarball) or links this folder for development.
#
# Usage:
#   ./install.sh                 install from npm (release channel)
#   ./install.sh --github        install from the GitHub repo (tracks main)
#   ./install.sh --link          dev: link this working copy (edits apply on restart)
#   ./install.sh --tarball FILE  install from a local .tgz
#   ./install.sh --uninstall     remove the plugin from the profile
#
# Profile: PROFILE=desktop (default) or PROFILE=web.
# The dsh CLI defaults to the bundled one inside the Desktop app; override with
# DSH_CLI=/path/to/dsh.
#
# Quit DeepSeek Harness before installing into the desktop profile: the app
# holds the profile lock while it runs.
set -eu

PKG='@xiaoyuyu6420/dsh-rewind'
REPO='github:xiaoyuyu6420/dsh-rewind'
profile=${PROFILE:-desktop}
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

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

mode=install
arg=${1:-}
case "$arg" in
  --uninstall|uninstall) mode=uninstall ;;
  --link|link) mode=link ;;
  --github|github) mode=github ;;
  --tarball|tarball)
    mode=tarball
    target=${2:-}
    if [ -z "$target" ]; then echo "dsh-rewind: --tarball needs a file path" >&2; exit 1; fi
    ;;
  --help|-h)
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  '') ;;
  *) echo "dsh-rewind: unknown option $arg (try --help)" >&2; exit 1 ;;
esac

echo "dsh-rewind: CLI     $dsh_cli"
echo "dsh-rewind: profile $profile"

case "$mode" in
  uninstall)
    "$dsh_cli" plugin --profile "$profile" remove "$PKG"
    echo "dsh-rewind: removed from the $profile profile. Restart DeepSeek Harness to apply."
    ;;
  install)
    "$dsh_cli" plugin --profile "$profile" add "$PKG"
    echo "dsh-rewind: installed from npm. Restart DeepSeek Harness, then reload the page."
    ;;
  github)
    "$dsh_cli" plugin --profile "$profile" add "$REPO"
    echo "dsh-rewind: installed from GitHub (main). Restart DeepSeek Harness to apply."
    ;;
  tarball)
    "$dsh_cli" plugin --profile "$profile" add "$target"
    echo "dsh-rewind: installed from $target. Restart DeepSeek Harness to apply."
    ;;
  link)
    "$dsh_cli" plugin --profile "$profile" add "link:$repo_dir"
    echo "dsh-rewind: installed (linked dev copy). Restart DeepSeek Harness to apply."
    echo "dsh-rewind: this folder is now the live source for the plugin."
    ;;
esac
