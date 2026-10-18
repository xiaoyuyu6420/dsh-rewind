# dsh-rewind

English | [中文](README.md)

Adds "re-do from before this question" to the DeepSeek Harness (DSH) Web UI:
each question gets a row of quick actions, and rewinding the conversation lets you
choose **whether** to also restore the workspace files the agent changed after that
question. Also ships a saved-prompt panel, input history with ↑↓, a one-click
"continue", starred-message jump, "copy this turn as Markdown", and a small mood
emoji that reacts to session state plus a rest reminder.

Targets **DSH 0.2.1-rc.2** (`webRuntime` and `conversationEvents` were renamed;
this plugin is written against the new contracts).

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
- ▶ **Continue** — send "继续" in one click (turns red when it fails)
- 🕘 **Input history** — dropdown, plus **↑↓ recall directly in an empty composer**
- ★ **Starred** — list starred messages and jump to that turn
- 😴/🤔/✨/🧋 **Mood emoji** — reacts to running / finished / rest-reminder

### Host half

- Records a workspace file checkpoint on every `turn/end` (content-addressed CAS
  snapshots; ignores `.git`, `node_modules`, etc.; honours `.gitignore`)
- **Auto git-commits** before every `turn/start` (optional, on by default) as an extra safety net
- Exposes a restore API that returns the workspace to a given turn/event boundary

## Install

```bash
dsh plugin --profile desktop add "file:/Users/xiao/Desktop/dsh/dsh-rewind"
```

> ⚠️ pnpm `file:` dependencies are **copied**, not symlinked. After editing the source
> you must re-run `add` (or copy the files over
> `~/.dsh/profiles/desktop/node_modules/@local/dsh-rewind/`) and restart DSH.

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
- Also tunable: `ignoreNames` / `ignorePatterns` / `trackSizeCap` / `blobSizeCap` /
  `maxFiles` / `maxTotalBlobBytes` / `enableGitignore`

Client (browser localStorage):

- `dsh-rewind.phrases` — saved prompts
- `dsh-rewind.restIntervalMs` — rest reminder interval (default 45 min)
- `dsh-rewind.history.<sessionId>` / `dsh-rewind.stars.<sessionId>` — history and stars

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
  locale/*.json     Display name and runtime copy (zh/en)
  icon.svg
```

## License

MIT — see [LICENSE](LICENSE)
