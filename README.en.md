# dsh-rewind

English | [中文](README.md)

Adds "re-do from before this question" to the DeepSeek Harness (DSH) Web UI:
each question gets a row of quick actions, and rewinding the conversation lets you
choose **whether** to also restore the workspace files the agent changed after that
question. Also ships a saved-prompt panel, input history with ↑↓, a one-click
"continue", starred-message jump, "copy this turn as Markdown", and a small mood
emoji that reacts to session state plus a rest reminder.

Targets **DSH 0.2.1-rc.5** (the same code passed full real-host verification on rc.2:
boot smoke 14/14, host unit tests 19/19, client static guard). The previous cut was only
"written against the new contracts"; this version actually runs them and fixes defects that
made the action row never render, the rewind never open the new session, and the
file restore silently fall back to the initial snapshot — see [docs/](docs/).

The rc.2 → rc.5 contract re-audit lives in [docs/compat-rc5.md](docs/compat-rc5.md):
boot smoke is still 14/14 on rc.5 and every host/client contract this plugin depends on is
unchanged, so **no code changes were needed**. The one thing to watch: rc.5 marks the whole
synchronous session-event read family (`snapshotEvents`/`ownEvents`/`eventAt`) deprecated —
the official packages still use it and there is no synchronous replacement — if it is ever
removed, restore degrades to the baseline snapshot (feature loss, no crash).

## Features

### Per-question action row

| Control | Effect |
|---|---|
| ↶ Roll back here | Forks a new session from before this question, discarding it and everything after; confirms first, with an "also restore workspace files" checkbox (on by default) |
| ✎ Edit & resend | Last question only: rewind + load the original text back into the composer for editing |
| 🔁 Regenerate | Fork from before this question and re-ask it verbatim (keeps files, no restore) |
| 📋 Copy Markdown | Copy this turn's question + answer as Markdown |
| ⭐ Star | Star/unstar a message; jump back to it from the composer |

### Composer toolbar

- 📝 **Saved prompts** — locally stored phrases, click to fill the composer, editable
- ▶ **Continue** — send "continue" in one click (turns red when it fails)
- 🕘 **Input history** — dropdown, plus **↑↓ recall directly in an empty composer**
- ★ **Starred** — list starred messages and jump to that turn
- 😴/🤔/✨/🧋 **Mood emoji** — reacts to running / finished / rest-reminder

### Host half

- Records a workspace file checkpoint on every `turn/end` (content-addressed CAS
  snapshots; ignores `.git`, `node_modules`, etc.; honours `.gitignore`)
- **Auto git-commits** before every `turn/start` (optional, on by default) as an extra safety net
- Exposes a restore API that returns the workspace to a given turn/event boundary

## Install

### Desktop: plugin manager (recommended)

DSH Desktop **Settings → Plugins → Add plugin**, then enter the npm name
`@xiaoyuyu6420/dsh-rewind`, the GitHub URL
`https://github.com/xiaoyuyu6420/dsh-rewind`, or an absolute path to a local `.tgz`.
Fully quit and restart DeepSeek Harness afterwards.

### Command line / web profile

```bash
dsh plugin --profile web add @xiaoyuyu6420/dsh-rewind        # npm
dsh plugin --profile web add github:xiaoyuyu6420/dsh-rewind  # GitHub (tracks main)
```

The bundled `install.sh` wraps every channel (it finds the bundled Desktop CLI
automatically; override with `DSH_CLI=/path/to/dsh`):

```bash
./install.sh                  # desktop profile, install from npm
./install.sh --github         # install from GitHub
./install.sh --tarball FILE    # install from a local .tgz
./install.sh --link           # dev: link this folder; edits apply on restart
./install.sh --uninstall      # uninstall
PROFILE=web ./install.sh      # other profile (desktop by default)
```

> ⚠️ For development use `--link` (a `link:` dependency): a pnpm `file:` dependency is
> **copied**, so you must re-run `add` after every edit. Do not change the desktop profile
> from the command line while the app is running — it holds the profile lock
> (`timed out waiting for the writer lock`).
> The `headless` profile does not apply this plugin (it injects `webServer`/`connection`).

Full install/config/troubleshooting guide: [docs/INSTALL.md](docs/INSTALL.md).
> ℹ️ **Not the same as the unscoped `dsh-rewind` on npm** — that one is a different project by l-dot
> (last updated 2026-08, and it injects a `conversationEvents` service that no longer exists in DSH 0.2.1,
> so it does not work on current hosts). This project publishes as the scoped
> `@xiaoyuyu6420/dsh-rewind` from [xiaoyuyu6420/dsh-rewind](https://github.com/xiaoyuyu6420/dsh-rewind).

Release channels and their current status: [docs/RELEASE.md](docs/RELEASE.md).

## Verification

On DSH 0.2.1-rc.2 (macOS arm64):

| Gate | Command | Result |
|---|---|---|
| Host unit tests | `node scripts/test-host.mjs --strict` | 19/19 (snapshots/restore/auth/git auto-commit/concurrency) |
| Real-host boot smoke | `node scripts/e2e-host.mjs` | 14/14 (isolated DSH_HOME, tarball install, boot 200, client bundle, API/401/405/404) |
| Real-turn end-to-end | `node scripts/e2e-turn.mjs` | 22/22 (isolated home + local fake model endpoint → **two real conversation turns** → checkpoints on disk → HTTP restore exactly restores files; see [docs/e2e-turn.md](docs/e2e-turn.md)) |
| Client static guard | `node scripts/check-client-static.mjs --strict` | PASS (`ctx.<service>` access matches `inject`; bundle loads and applies in a sandbox) |
| Runtime contract guard | `node scripts/check-runtime-contract.mjs` | 17/17 PASS (the host/client contracts this plugin depends on — **run this first after upgrading DSH**; see [docs/runtime-contract.md](docs/runtime-contract.md)) |

All tests use a temporary `DSH_HOME` and never touch your real `~/.dsh`; the e2e
script reports an explicit SKIP when `dsh`/`pnpm`/network are unavailable.

## Configuration

Host: `~/.dsh/storages/dsh-rewind/config.json`

```json
{
  "enabled": true,
  "gitAutoCommit": true,
  "gitCommitPrefix": "dsh: checkpoint before turn"
}
```

- `enabled: false` — disable file checkpoints
- `gitAutoCommit: false` — disable the per-turn auto git commit
  (it only runs when the session workspace is the git work-tree root, and skips
  while a merge/rebase/cherry-pick is in progress)
- Also tunable: `ignoreNames` / `ignorePatterns` / `trackSizeCap` / `blobSizeCap` /
  `maxFiles` / `maxTotalBlobBytes` / `enableGitignore`

Client (browser localStorage):

- `dsh-rewind.phrases` — saved prompts
- `dsh-rewind.restIntervalMs` — rest reminder interval (default 45 min)
- `dsh-rewind.history.<sessionId>` / `dsh-rewind.stars.<sessionId>` — history and stars

## Known limitations

- **Restore is destructive**: files created by hand after the checkpoint (and not
  ignored) are deleted, and there is no "undo the last restore". Commit/back up
  important work first, or temporarily set `enabled: false`.
- Files larger than `blobSizeCap` (1MB by default) are fingerprinted but their
  content is not stored, so they are `skipped` on restore.
- A session workspace that is an **ancestor of `$DSH_HOME`** (for example the whole
  home directory) is not tracked, so `~/.dsh` (including credentials) never enters snapshots.
- The custom action row is anchored at `seq + 0.1` below the question, which may drop
  that turn's `/skill` name decoration (presentation only).
- History/stars live in browser localStorage per session; rewind/fork renumbers turns,
  so old stars may point at a different turn.
- Cold sessions restored after a host restart need checkpoints created while the
  session was live (they are read back from the session persistence log).
- Web/desktop profiles only: the plugin injects `webServer` and `connection` (restore goes over
  HTTP), so the `headless` profile never applies it — no checkpoints under `dsh --profile headless` is expected.

## Crash safety

DSH clears an entire slot entry when a renderer throws
(`slot entry crashed in '<slot>'`). This plugin is built so a crash is structurally impossible:

- Every slot entry is wrapped in a **React error boundary** (unmounts the subtree, renders `null`)
- Snapshot computation goes through `safeCompute` (throw → fallback value)
- Async flows go through `runGuarded` (throw → uniform result, never rethrown)
- DOM access goes through `safeDom`
- Auth failures are **fail-closed** (503, never open)

Worst case: one slot silently disappears plus a
`[dsh-rewind] slot entry crashed` console line — no blanked UI, no impact on other plugins.

## Layout

```
dsh-rewind/
  index.js          Host half: file checkpoints, git auto-commit, restore API
  client.js         Client half: slot UI, quick actions, mood
  cordis.patch.yml  Loader plugin row
  package.json      dsh.bundle.patch + dsh.client
  install.sh        Install/uninstall (npm / GitHub / tarball / link dev mode)
  locale/*.json     Display name and description (zh/en)
  scripts/          Verification: host unit tests, real-host boot smoke, client static guard, runtime contract guard
  docs/             INSTALL guide, contract audits, fix records, test report, final verification, version compatibility, runtime contract
  icon.svg
```

## License

MIT — see [LICENSE](LICENSE)
