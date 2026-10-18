// Client half of @local/dsh-rewind (v3, crash-hardened).
//
// Rendering contract: this plugin MUST NOT crash a host slot. Any uncaught
// throw inside a slot renderer makes DSH log `slot entry crashed in '<slot>'`
// and blank that slot entry. Every slot entry therefore goes through
// SlotErrorBoundary, every pure computation through safeCompute, every async
// flow through runGuarded, and every DOM touch through safeDom.
//
// Adapted for DSH 0.2.x: `conversationEvents` -> `uiConversation.events`,
// open via `uiWorkspace.openSession`, archive via `workspaces.archiveSession({ sessionId })`,
// prompt via `session.prompt([{ type: "text", text }], "queue")`,
// create accepts `{ workspaceId }` or `{ cwd }`.
window.__ModuleLoader__.load({
  id: "@local/dsh-rewind",
  factory(require) {
    const React = require("react");
    const { useState, useEffect, useRef, useCallback, Component } = React;
    const h = React.createElement;

    const NS = "dsh-rewind";

    const ZH = {
      rollback: "回退到此",
      rollbackConfirm: "确认回退？将丢弃这条提问及其后的对话",
      rollbackBusy: "回退中…",
      rollbackDone: "已回退：还原 {restored} 个文件，删除 {deleted} 个",
      rollbackPartial: "已回退：还原 {restored} 个文件，删除 {deleted} 个（{skipped} 个跳过）",
      rollbackNone: "已回退（本会话没有可还原的文件记录）",
      restoreFailed: "对话已回退，但工作区文件还原失败",
      restoreFiles: "同时还原工作区文件",
      edit: "修改并重发",
      editBusy: "处理中…",
      regenerate: "重新生成（保留文件）",
      regenerateFailed: "重新生成失败",
      copyMarkdown: "复制本轮问答为 Markdown",
      copyDone: "已复制",
      copyFailed: "复制失败",
      star: "收藏这条消息",
      starRemove: "取消收藏",
      continueBtn: "继续",
      continueFailed: "发送「继续」失败",
      history: "输入历史",
      historyEmpty: "暂无历史",
      phrasePanel: "常用提示词",
      phraseEdit: "编辑",
      phraseSave: "保存",
      phraseEmpty: "暂无短语，点「编辑」添加",
      phraseHint: "每行一条短语",
      starred: "收藏的消息",
      starredEmpty: "暂无收藏",
      cancel: "取消",
      confirm: "确认",
      errorPrefix: "操作失败：",
      mood: "状态",
      "mood.cheer1": "这轮结束啦，辛苦 ☕",
      "mood.cheer2": "搞定 ✨ 继续加油",
      "mood.cheer3": "稳稳的，挺好 🌿",
      "mood.cheer4": "想换个方向？点 ↶ 就能回退",
      "mood.rest1": "已经忙了一阵，起来走走 🧋",
      "mood.rest2": "喝口水，看看远处 🌿"
    };
    const EN = {
      rollback: "Roll back here",
      rollbackConfirm: "Confirm rollback? This discards this question and everything after it",
      rollbackBusy: "Rolling back…",
      rollbackDone: "Rolled back: restored {restored} files, deleted {deleted}",
      rollbackPartial: "Rolled back: restored {restored}, deleted {deleted} ({skipped} skipped)",
      rollbackNone: "Rolled back (no restorable file records for this session)",
      restoreFailed: "Conversation rolled back, but restoring workspace files failed",
      restoreFiles: "Also restore workspace files",
      edit: "Edit & resend",
      editBusy: "Working…",
      regenerate: "Regenerate (keep files)",
      regenerateFailed: "Regenerate failed",
      copyMarkdown: "Copy this turn as Markdown",
      copyDone: "Copied",
      copyFailed: "Copy failed",
      star: "Star this message",
      starRemove: "Unstar",
      continueBtn: "Continue",
      continueFailed: "Sending “continue” failed",
      history: "Input history",
      historyEmpty: "No history",
      phrasePanel: "Saved prompts",
      phraseEdit: "Edit",
      phraseSave: "Save",
      phraseEmpty: "No saved prompts, click Edit to add",
      phraseHint: "One prompt per line",
      starred: "Starred messages",
      starredEmpty: "No starred messages",
      cancel: "Cancel",
      confirm: "Confirm",
      errorPrefix: "Failed: ",
      mood: "Status",
      "mood.cheer1": "That turn's done — nice work ☕",
      "mood.cheer2": "Done ✨ keep going",
      "mood.cheer3": "Smooth 🌿",
      "mood.cheer4": "Want a do-over? Hit ↶ to rewind",
      "mood.rest1": "You've been at it a while — stretch 🧋",
      "mood.rest2": "Water break, look away for a bit 🌿"
    };

    // ---- module-level state ----
    let pluginCtx = null;
    let currentSessionId = null;
    let historyIndex = -1;
    const historyCache = new Map();
    const wrappedSessions = new Set();

    // ---- crash-proofing primitives ----

    /** Run a pure-ish computation; on throw, return `fallback` instead of crashing the slot. */
    function safeCompute(fallback, fn) {
      try { return fn(); } catch (error) { console.error("[dsh-rewind] compute failed:", error); return fallback; }
    }

    /** Run an async flow; never throws — always resolves to { ok, value?, message? }. */
    async function runGuarded(fn) {
      try {
        const value = await fn();
        return { ok: true, value };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[dsh-rewind] action failed:", error);
        return { ok: false, message };
      }
    }

    /** Touch the DOM without ever throwing or returning a value we depend on. */
    function safeDom(fn) {
      try { fn(); return true; } catch { return false; }
    }

    /** Read localStorage as a parsed value, or `fallback` on any failure. */
    function readStore(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null || raw === undefined) return fallback;
        const parsed = JSON.parse(raw);
        return parsed ?? fallback;
      } catch { return fallback; }
    }
    function writeStore(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    }

    /** Awaited value that resolves even if the promise rejects. */
    async function settle(promise) {
      try { const value = await promise; return { ok: true, value }; }
      catch (error) { return { ok: false, error }; }
    }

    // ---- helpers ----
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function callApi(method, payload) {
      const res = await fetch(`/dsh-rewind/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      let body = null;
      try { body = await res.json(); } catch {}
      if (body === null || body.ok !== true) {
        throw new Error(body?.error?.message ?? `dsh-rewind ${method} failed (HTTP ${res.status})`);
      }
      return body.value;
    }

    /** Cancel a running turn; never throws. */
    async function cancelIfRunning(ctx, sessionId) {
      const binding = safeCompute(undefined, () => ctx.sessions.binding(sessionId));
      if (binding === undefined || binding.session === undefined) return;
      await settle(binding.session.cancel());
    }

    /** Archive the old session; never throws. */
    async function archive(ctx, sessionId) {
      await settle(ctx.workspaces.archiveSession({ sessionId }));
    }

    /** Replace the composer draft for a session; never throws. */
    async function setDraftOn(ctx, sessionId, text) {
      const conversation = safeCompute(undefined, () => ctx.get("conversation"));
      if (conversation === undefined) return false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const scope = safeCompute(undefined, () => ctx.sessions.scope(sessionId));
        const ok = safeCompute(false, () => {
          conversation.input.for(scope).setDraft(text);
          return true;
        });
        if (ok) return true;
        await sleep(50);
      }
      return false;
    }

    /** Send one text block into a session; returns whether the host accepted it. */
    async function sendText(ctx, sessionId, text) {
      const binding = safeCompute(undefined, () => ctx.sessions.binding(sessionId));
      if (binding === undefined || binding.session === undefined) return false;
      const result = await settle(binding.session.prompt([{ type: "text", text }], "queue"));
      if (!result.ok) return false;
      return result.value === undefined ? true : result.value.ok !== false;
    }

    /**
     * Cut the conversation back to `boundarySeqOrNull` and open the child.
     * Never throws. Restoring files happens best-effort — a restore failure
     * still leaves the conversation cut complete, and is reported separately.
     */
    async function cutBefore(ctx, sessionId, boundarySeqOrNull, restoreFiles, draftText) {
      await cancelIfRunning(ctx, sessionId);
      const cut = { childId: null, restore: null, restoreError: "" };
      const createOrFork = async () => {
        if (boundarySeqOrNull === null) {
          const cwd = safeCompute(undefined, () => ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd);
          const workspace = safeCompute(undefined, () => {
            const items = ctx.workspaces.list.getSnapshot().items;
            return Array.isArray(items) ? items.find((i) => i !== null && i.path === cwd) : undefined;
          });
          const request = workspace !== undefined && workspace.workspaceId !== undefined
            ? { workspaceId: workspace.workspaceId }
            : (typeof cwd === "string" && cwd !== "" ? { cwd } : {});
          return ctx.sessions.create(request);
        }
        return ctx.sessions.fork({ sessionId, atSeq: boundarySeqOrNull });
      };

      const created = await settle(createOrFork());
      if (created.ok && (typeof created.value === "string" || typeof created.value === "number")) {
        cut.childId = String(created.value);
      }

      if (restoreFiles) {
        const payload = boundarySeqOrNull === null
          ? { sessionId, baseline: true, dryRun: false }
          : { sessionId, atSeq: boundarySeqOrNull, dryRun: false };
        const restored = await settle(callApi("restore", payload));
        if (restored.ok) cut.restore = restored.value ?? null;
        else cut.restoreError = restored.error instanceof Error ? restored.error.message : String(restored.error);
      }

      await archive(ctx, sessionId);
      if (cut.childId !== null) {
        safeCompute(undefined, () => ctx.uiWorkspace.openSession(cut.childId));
        if (typeof draftText === "string" && draftText !== "") await setDraftOn(ctx, cut.childId, draftText);
      }
      return cut;
    }

    async function copyText(text) {
      try { await navigator.clipboard.writeText(text); return true; }
      catch {
        return safeCompute(false, () => {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
          return true;
        });
      }
    }

    // ---- input history ----
    function historyKey(sessionId) { return `dsh-rewind.history.${sessionId}`; }
    function loadHistory(sessionId) {
      const arr = readStore(historyKey(sessionId), []);
      if (!Array.isArray(arr)) return [];
      return arr.filter((s) => typeof s === "string" && s !== "");
    }
    function saveHistory(sessionId, arr) { writeStore(historyKey(sessionId), arr.slice(-50)); }
    function ensurePromptWrapped(sessionId) {
      if (pluginCtx === null || wrappedSessions.has(sessionId)) return;
      const binding = safeCompute(undefined, () => pluginCtx.sessions.binding(sessionId));
      if (binding === undefined || binding.session === undefined) return;
      const session = binding.session;
      if (session.__rewindHistoryWrapped === true) return;
      session.__rewindHistoryWrapped = true;
      wrappedSessions.add(sessionId);
      const original = safeCompute(null, () => session.prompt.bind(session));
      if (original === null) return;
      session.prompt = async (content, mode, signal, requestId) => {
        const text = safeCompute("", () => {
          if (typeof content === "string") return content;
          if (Array.isArray(content)) return content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
          return "";
        });
        if (text.trim() !== "") {
          const arr = loadHistory(sessionId);
          arr.push(text);
          saveHistory(sessionId, arr);
          historyCache.set(sessionId, arr);
          historyIndex = -1;
        }
        return original(content, mode, signal, requestId);
      };
    }
    function setDraftNow(sessionId, text) { void setDraftOn(pluginCtx, sessionId, text); }

    // ---- starred ----
    function starsKey(sessionId) { return `dsh-rewind.stars.${sessionId}`; }
    function loadStars(sessionId) {
      const arr = readStore(starsKey(sessionId), []);
      if (!Array.isArray(arr)) return [];
      return arr.filter((n) => Number.isInteger(n));
    }
    function saveStars(sessionId, arr) { writeStore(starsKey(sessionId), arr); }
    function jumpToTurn(turn) {
      safeDom(() => {
        const el = document.querySelector(`[data-chat-turn="${turn}"]`);
        if (el !== null && typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    }

    // ---- snapshot helpers (all wrapped by safeCompute at call sites) ----
    function textOfContent(content) {
      if (!Array.isArray(content)) return "";
      return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
    }
    function completedTurnEnds(chatSnap) {
      const ends = new Map();
      const turns = chatSnap.timeline?.turns;
      if (turns === undefined || typeof turns.values !== "function") return ends;
      for (const turn of turns.values()) {
        if (turn !== null && turn !== undefined && turn.end !== undefined && turn.end !== null) {
          ends.set(turn.turn, turn.end.seq);
        }
      }
      return ends;
    }
    function turnOfNode(chatSnap, nodeKey) {
      const order = chatSnap.timeline?.turnOrder;
      if (!Array.isArray(order)) return undefined;
      return order.find((turn) => {
        const keys = safeCompute([], () => chatSnap.locations.getTurn(turn));
        return Array.isArray(keys) && keys.includes(nodeKey);
      });
    }
    function analyzeQuestion(chatSnap, nodeKey) {
      const node = safeCompute(undefined, () => chatSnap.nodes.get(nodeKey));
      if (node === undefined || node === null || node.kind !== "user") return null;
      const turn = turnOfNode(chatSnap, nodeKey);
      if (turn === undefined) return null;
      const userText = textOfContent(node.data?.content);
      const ends = completedTurnEnds(chatSnap);
      const previousCompleted = [...ends.keys()].filter((c) => Number.isInteger(c) && c < turn).sort((a, b) => a - b).at(-1);
      const boundarySeq = previousCompleted === undefined ? null : ends.get(previousCompleted) ?? null;
      let maxUserSeq;
      for (const n of safeCompute([], () => [...chatSnap.nodes.values()])) {
        if (n !== null && n !== undefined && n.kind === "user" && typeof n.anchorSeq === "number") {
          if (maxUserSeq === undefined || n.anchorSeq > maxUserSeq) maxUserSeq = n.anchorSeq;
        }
      }
      const nodeSeq = typeof node.anchorSeq === "number" ? node.anchorSeq : undefined;
      const isLastQuestion = maxUserSeq !== undefined && nodeSeq !== undefined && nodeSeq >= maxUserSeq;
      return { turn, nodeSeq, userText, isLastQuestion, boundarySeq };
    }
    function assistantTextOfTurn(chatSnap, turn) {
      const keys = safeCompute([], () => chatSnap.locations.getTurn(turn));
      const parts = [];
      for (const key of keys) {
        const n = safeCompute(undefined, () => chatSnap.nodes.get(key));
        if (n === undefined || n === null || n.kind !== "assistant-step") continue;
        const blocks = n.data?.blocks;
        if (Array.isArray(blocks)) {
          for (const b of blocks) if (b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "") parts.push(b.text);
        }
      }
      return parts.join("\n\n");
    }

    // ---- icons ----
    const svgProps = { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
    const UndoIcon = () => h("svg", svgProps, h("path", { d: "M4.2 6.5h5.3a3.5 3.5 0 0 1 0 7H5.5" }), h("path", { d: "M6.8 3.6 3.6 6.5l3.2 2.9" }));
    const EditIcon = () => h("svg", { ...svgProps, strokeWidth: 1.5 }, h("path", { d: "M11.2 2.8 13.2 4.8 5.4 12.6l-3 .9.9-3z" }), h("path", { d: "m10.2 3.8 2 2" }));
    const RegenerateIcon = () => h("svg", svgProps, h("path", { d: "M13 8a5 5 0 1 1-1.5-3.5" }), h("path", { d: "M13 2v3h-3" }));
    const CopyIcon = () => h("svg", svgProps, h("rect", { x: 5, y: 5, width: 8, height: 8, rx: 1 }), h("path", { d: "M3 11V4a1 1 0 0 1 1-1h7" }));
    const StarIcon = ({ filled }) => h("svg", { ...svgProps, fill: filled ? "currentColor" : "none" }, h("path", { d: "M8 2l1.8 3.6 4 .6-2.9 2.8.7 4L8 11.2 4.4 13l.7-4L2.2 6.2l4-.6z" }));
    const ContinueIcon = () => h("svg", { ...svgProps, fill: "currentColor", stroke: "none" }, h("path", { d: "M5 3l8 5-8 5z" }));
    const HistoryIcon = () => h("svg", svgProps, h("path", { d: "M3 12a9 9 0 1 1 1.5-6.5" }), h("path", { d: "M3 3v4h4" }), h("path", { d: "M8 5v4l3 2" }));
    const PhraseIcon = () => h("svg", { ...svgProps, strokeWidth: 1.5 }, h("path", { d: "M3 5h10M5 3h6l2 2v9H5z" }), h("path", { d: "M6 9h4M6 11h2" }));

    const iconButtonStyle = {
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 22, height: 22, padding: 0, border: "none", borderRadius: "50%",
      background: "transparent", color: "var(--dsw-alias-label-tertiary, inherit)",
      opacity: 0.55, cursor: "pointer"
    };

    /**
     * Last line of defence: if anything below throws during render, unmount the
     * whole subtree and render nothing. The host slot stays alive.
     */
    class SlotErrorBoundary extends Component {
      constructor(props) {
        super(props);
        this.state = { crashed: false };
      }
      static getDerivedStateFromError() { return { crashed: true }; }
      componentDidCatch(error) { console.error(`[dsh-rewind] slot entry crashed (${this.props.label ?? "slot"}):`, error); }
      render() {
        if (this.state.crashed) return null;
        return this.props.children ?? null;
      }
    }
    const guardSlot = (label, element) => h(SlotErrorBoundary, { label }, element);

    /** Subscribe to a host snapshot hook defensively; a missing hook yields the fallback. */
    function useSnapshot(useHook, fallback, select) {
      if (typeof useHook !== "function") return fallback;
      return useHook((snap) => safeCompute(fallback, () => select(snap)));
    }

    // ---- per-question action row ----
    function QuestionActions(props) {
      const { node, sessionId, useChat, t, ctx } = props;
      const info = useSnapshot(useChat, null, (snap) => analyzeQuestion(snap, node.key));
      const mdText = useSnapshot(useChat, "", (snap) => {
        const q = analyzeQuestion(snap, node.key);
        if (q === null) return "";
        return `## Q\n${q.userText}\n\n## A\n${assistantTextOfTurn(snap, q.turn)}`;
      });
      const [confirming, setConfirming] = useState(false);
      const [restoreFiles, setRestoreFiles] = useState(true);
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState(null);
      const [starred, setStarred] = useState(() => safeCompute(false, () => loadStars(sessionId).includes(info?.turn)));

      useEffect(() => {
        const turn = info?.turn;
        setStarred(turn !== undefined && safeCompute(false, () => loadStars(sessionId).includes(turn)));
      }, [sessionId, info?.turn]);

      if (info === null) return null;
      const canEdit = info.isLastQuestion === true;

      const show = (text, tone) => setNote({ text, tone: tone ?? "info" });

      const doRollback = async (restore, draftText) => {
        setBusy(true);
        setNote(null);
        const result = await runGuarded(() => cutBefore(ctx, sessionId, info.boundarySeq, restore, draftText));
        if (!result.ok) {
          setBusy(false);
          show(t("errorPrefix") + result.message, "error");
          return;
        }
        const cut = result.value;
        if (cut.childId === null) {
          setBusy(false);
          show(t("errorPrefix") + "fork failed", "error");
          return;
        }
        if (cut.restoreError !== "") {
          show(`${t("restoreFailed")}：${cut.restoreError}`, "error");
        } else if (restore) {
          const r = cut.restore;
          const restored = r?.restored?.length ?? 0;
          const deleted = r?.deleted?.length ?? 0;
          const skipped = r?.skipped?.length ?? 0;
          if (r === null || r === undefined || (restored === 0 && deleted === 0)) {
            show(t("rollbackNone"), "info");
          } else if (skipped > 0) {
            show(t("rollbackPartial", { restored, deleted, skipped }), "info");
          } else {
            show(t("rollbackDone", { restored, deleted }), "info");
          }
        }
        setBusy(false);
      };

      const onRollback = () => {
        if (busy) return;
        if (!confirming) { setConfirming(true); return; }
        setConfirming(false);
        void doRollback(restoreFiles, undefined);
      };
      const onEdit = () => {
        if (busy || !canEdit) return;
        if (!confirming) { setConfirming(true); return; }
        setConfirming(false);
        void doRollback(restoreFiles, info.userText);
      };
      const onRegenerate = async () => {
        if (busy) return;
        setBusy(true);
        setNote(null);
        const result = await runGuarded(async () => {
          const cut = await cutBefore(ctx, sessionId, info.boundarySeq, false, undefined);
          if (cut.childId === null) return { ok: false };
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const sent = await sendText(ctx, cut.childId, info.userText);
            if (sent) return { ok: true };
            await sleep(50);
          }
          return { ok: false };
        });
        setBusy(false);
        if (!result.ok || result.value?.ok !== true) show(t("regenerateFailed"), "error");
      };
      const onCopy = async () => {
        const ok = await runGuarded(() => copyText(typeof mdText === "string" ? mdText : ""));
        if (ok.ok && ok.value === true) show(t("copyDone"), "info");
        else show(t("copyFailed"), "error");
      };
      const onStar = () => {
        safeDom(() => {
          const next = loadStars(sessionId);
          const i = next.indexOf(info.turn);
          if (i >= 0) next.splice(i, 1); else next.push(info.turn);
          saveStars(sessionId, next);
          setStarred(i < 0);
        });
      };

      const chip = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: "12px", color: "var(--dsw-alias-label-secondary, inherit)" };

      return h("div",
        { style: { display: "flex", flexDirection: "column", gap: 4, margin: "1px 0", alignItems: "flex-end" }, "data-dsh-rewind-actions": `t${info.turn}` },
        h("div", { style: { display: "flex", alignItems: "center", gap: 2, height: 22 } },
          h("button", {
            type: "button", className: "rc-icon-btn", disabled: busy,
            style: confirming ? { ...iconButtonStyle, color: "#fff", background: "#d9534f", opacity: 1 } : iconButtonStyle,
            title: confirming ? t("rollbackConfirm") : t("rollback"), onClick: onRollback
          }, h(UndoIcon)),
          canEdit ? h("button", { type: "button", className: "rc-icon-btn", disabled: busy, style: iconButtonStyle, title: t("edit"), onClick: onEdit }, h(EditIcon)) : null,
          h("button", { type: "button", className: "rc-icon-btn", disabled: busy, style: iconButtonStyle, title: t("regenerate"), onClick: () => void onRegenerate() }, h(RegenerateIcon)),
          h("button", { type: "button", className: "rc-icon-btn", style: iconButtonStyle, title: t("copyMarkdown"), onClick: () => void onCopy() }, h(CopyIcon)),
          h("button", { type: "button", className: "rc-icon-btn", style: { ...iconButtonStyle, opacity: starred ? 1 : 0.55 }, title: starred ? t("starRemove") : t("star"), onClick: onStar }, h(StarIcon, { filled: starred }))
        ),
        confirming ? h("div", { style: { ...chip, padding: "4px 8px", border: "1px solid var(--dsw-alias-border-l1, #333)", borderRadius: "8px", background: "var(--dsw-alias-interactive-bg, rgba(0,0,0,.04))" } },
          h("label", { style: chip },
            h("input", { type: "checkbox", checked: restoreFiles, onChange: (e) => setRestoreFiles(e.target.checked) }),
            t("restoreFiles")),
          h("button", { type: "button", style: { ...iconButtonStyle, width: "auto", padding: "0 6px", borderRadius: "6px", opacity: 1 }, onClick: () => { setConfirming(false); void doRollback(restoreFiles, canEdit ? info.userText : undefined); } }, t("confirm")),
          h("button", { type: "button", style: { ...iconButtonStyle, width: "auto", padding: "0 6px", borderRadius: "6px", opacity: 1 }, onClick: () => setConfirming(false) }, t("cancel"))
        ) : null,
        busy ? h("div", { style: chip }, t("rollbackBusy")) : null,
        note !== null ? h("div", { style: { ...chip, color: note.tone === "error" ? "#d9534f" : undefined } }, note.text) : null
      );
    }

    // ---- composer toolbar ----

    const PHRASES_KEY = "dsh-rewind.phrases";
    function loadPhrases() {
      const arr = readStore(PHRASES_KEY, []);
      return Array.isArray(arr) ? arr.filter((s) => typeof s === "string" && s !== "") : [];
    }
    function useActiveSession(sessionId) {
      useEffect(() => {
        currentSessionId = sessionId;
        return () => { if (currentSessionId === sessionId) currentSessionId = null; };
      }, [sessionId]);
    }
    const composerBtn = {
      display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer",
      border: "none", background: "transparent", padding: "4px",
      color: "var(--dsw-alias-label-tertiary, inherit)", borderRadius: "6px"
    };
    const popBase = {
      position: "absolute", bottom: "calc(100% + 6px)", left: 0, zIndex: 1000,
      minWidth: 220, maxWidth: 340, maxHeight: 320, overflow: "auto",
      background: "var(--dsw-alias-surface, #fff)", color: "var(--dsw-alias-label-primary, inherit)",
      border: "1px solid var(--dsw-alias-border-l1, #333)", borderRadius: "10px",
      boxShadow: "0 8px 24px rgba(0,0,0,.18)", padding: 8
    };
    const popRow = { display: "block", width: "100%", textAlign: "left", padding: "6px 8px", border: "none", background: "transparent", color: "inherit", cursor: "pointer", borderRadius: "6px", fontSize: "13px" };

    function PhrasePanel(props) {
      const { sessionId, t, ctx } = props;
      useActiveSession(sessionId);
      const [open, setOpen] = useState(false);
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState("");
      const [phrases, setPhrases] = useState(loadPhrases);
      const insert = (text) => { void setDraftOn(ctx, sessionId, text); setOpen(false); };
      const save = () => {
        const next = draft.split("\n").map((s) => s.trim()).filter((s) => s !== "");
        writeStore(PHRASES_KEY, next);
        setPhrases(next);
        setEditing(false);
      };
      return h("div", { style: { position: "relative", display: "inline-flex", alignItems: "center" } },
        h("button", { type: "button", style: composerBtn, title: t("phrasePanel"), onClick: () => { setOpen((v) => !v); setEditing(false); } }, h(PhraseIcon)),
        open ? h("div", { style: popBase },
          editing
            ? h("div", null,
                h("textarea", { style: { width: "100%", minHeight: 120, boxSizing: "border-box", background: "transparent", color: "inherit", border: "1px solid var(--dsw-alias-border-l1, #333)", borderRadius: "6px", padding: 6, fontSize: 13 }, value: draft, onChange: (e) => setDraft(e.target.value), placeholder: t("phraseHint") }),
                h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 6 } },
                  h("button", { type: "button", style: popRow, onClick: save }, t("phraseSave")),
                  h("button", { type: "button", style: popRow, onClick: () => setEditing(false) }, t("cancel"))))
            : h("div", null,
                phrases.length === 0 ? h("div", { style: { ...popRow, cursor: "default", opacity: 0.6 } }, t("phraseEmpty")) : null,
                phrases.map((p) => h("button", { key: p, type: "button", style: popRow, onClick: () => insert(p) }, p)),
                h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 4, borderTop: "1px solid var(--dsw-alias-border-l1, #333)", paddingTop: 6 } },
                  h("button", { type: "button", style: popRow, onClick: () => { setDraft(phrases.join("\n")); setEditing(true); } }, t("phraseEdit"))))) : null
      );
    }

    function ContinueButton(props) {
      const { sessionId, t, ctx } = props;
      useActiveSession(sessionId);
      const [busy, setBusy] = useState(false);
      const [failed, setFailed] = useState(false);
      const onClick = async () => {
        if (busy) return;
        setBusy(true);
        setFailed(false);
        const sent = await runGuarded(() => sendText(ctx, sessionId, "继续"));
        setBusy(false);
        if (!sent.ok || sent.value !== true) setFailed(true);
      };
      return h("button", {
        type: "button", style: { ...composerBtn, color: failed ? "#d9534f" : undefined },
        title: failed ? t("continueFailed") : t("continueBtn"), disabled: busy, onClick: () => void onClick()
      }, h(ContinueIcon));
    }

    function HistoryButton(props) {
      const { sessionId, t, ctx } = props;
      useActiveSession(sessionId);
      useEffect(() => { ensurePromptWrapped(sessionId); }, [sessionId]);
      const [open, setOpen] = useState(false);
      const [items, setItems] = useState(() => historyCache.get(sessionId) ?? loadHistory(sessionId));
      const refresh = () => setItems(historyCache.get(sessionId) ?? loadHistory(sessionId));
      const pick = (text) => { void setDraftOn(ctx, sessionId, text); setOpen(false); };
      return h("div", { style: { position: "relative", display: "inline-flex", alignItems: "center" } },
        h("button", { type: "button", style: composerBtn, title: t("history"), onClick: () => { refresh(); setOpen((v) => !v); } }, h(HistoryIcon)),
        open ? h("div", { style: popBase },
          items.length === 0 ? h("div", { style: { ...popRow, cursor: "default", opacity: 0.6 } }, t("historyEmpty"))
            : items.slice().reverse().map((p, i) => h("button", { key: `${i}-${p.slice(0, 20)}`, type: "button", style: popRow, onClick: () => pick(p) }, p))
        ) : null
      );
    }

    function StarPanel(props) {
      const { sessionId, t } = props;
      useActiveSession(sessionId);
      const [open, setOpen] = useState(false);
      const [stars, setStars] = useState(() => loadStars(sessionId));
      const refresh = () => setStars(loadStars(sessionId));
      const jump = (turn) => { jumpToTurn(turn); setOpen(false); };
      return h("div", { style: { position: "relative", display: "inline-flex", alignItems: "center" } },
        h("button", { type: "button", style: composerBtn, title: t("starred"), onClick: () => { refresh(); setOpen((v) => !v); } }, h(StarIcon, { filled: true })),
        open ? h("div", { style: popBase },
          stars.length === 0 ? h("div", { style: { ...popRow, cursor: "default", opacity: 0.6 } }, t("starredEmpty"))
            : stars.map((turn) => h("button", { key: String(turn), type: "button", style: popRow, onClick: () => jump(turn) }, `第 ${turn} 轮`))
        ) : null
      );
    }

    // ---- mood companion ----
    const MOOD_CHEER = ["mood.cheer1", "mood.cheer2", "mood.cheer3", "mood.cheer4"];
    const MOOD_REST = ["mood.rest1", "mood.rest2"];
    const REST_DEFAULT_MS = 45 * 60 * 1000;
    const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)] ?? arr[0];
    function restIntervalMs() {
      const raw = safeCompute(null, () => localStorage.getItem("dsh-rewind.restIntervalMs"));
      const v = Number(raw);
      if (Number.isFinite(v) && v >= 60 * 1000) return v;
      return REST_DEFAULT_MS;
    }

    function Companion(props) {
      const { sessionId, t, ctx } = props;
      useActiveSession(sessionId);
      const readRunning = () => safeCompute(false, () => ctx.sessions.list.getSnapshot().byId[sessionId]?.running === true);
      const [running, setRunning] = useState(readRunning);
      const [mood, setMood] = useState(null);
      const prev = useRef(running);
      const activeSince = useRef(null);
      const lastRemind = useRef(0);

      useEffect(() => {
        const id = setInterval(() => {
          const now = Date.now();
          const r = readRunning();
          setRunning((old) => (old === r ? old : r));
          if (r && !prev.current) activeSince.current = now;
          else if (!r && prev.current) {
            activeSince.current = null;
            setMood({ emoji: "✨", text: t(pickOne(MOOD_CHEER)), until: now + 4000 });
          }
          prev.current = r;
          if (r && activeSince.current !== null && now - activeSince.current >= restIntervalMs() && now - lastRemind.current >= restIntervalMs()) {
            lastRemind.current = now;
            setMood({ emoji: "🧋", text: t(pickOne(MOOD_REST)), until: now + 6000 });
          }
          setMood((m) => (m !== null && m.until < now ? null : m));
        }, 1000);
        return () => clearInterval(id);
      }, [sessionId, ctx, t]);

      const emoji = mood !== null ? mood.emoji : running ? "🤔" : "😴";
      return h("div", { style: { position: "relative", display: "inline-flex", alignItems: "center" } },
        h("button", { type: "button", style: { ...composerBtn, fontSize: 14 }, title: t("mood"), onClick: () => setMood(null) }, emoji),
        mood !== null ? h("div", { style: {
          position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 84, zIndex: 1100,
          background: "var(--dsw-alias-surface, #fff)", color: "var(--dsw-alias-label-primary, inherit)",
          border: "1px solid var(--dsw-alias-border-l1, #333)", borderRadius: "12px",
          padding: "6px 12px", fontSize: "13px", boxShadow: "0 6px 20px rgba(0,0,0,.18)", whiteSpace: "nowrap"
        } }, mood.text) : null
      );
    }

    // ---- event definition ----
    const rewindDefinition = {
      kind: "dsh-rewind-actions",
      target: "chat",
      match: (event) => {
        if (!event || event.type !== "user/message") return null;
        if (event.data?.source?.kind !== "user") return null;
        return { id: String(event.data?.id ?? event.seq), role: "start" };
      },
      start: (_context, match) => ({
        seq: match?.event?.seq,
        time: match?.event?.time,
        content: match?.event?.data?.content ?? []
      }),
      update: (context) => context.state,
      buildViewNode: (context) => {
        if (context.state === undefined || context.state === null) return null;
        const state = context.state.seq === undefined ? { ...context.state, seq: 0 } : context.state;
        const location = context.start?.location ?? context.matches?.[0]?.location ?? { kind: "unresolved" };
        return {
          key: context.key,
          kind: "dsh-rewind-actions",
          id: context.id,
          target: "chat",
          anchorSeq: state.seq + 0.1,
          location,
          visibility: "visible",
          data: state
        };
      }
    };

    return {
      inject: ["slots", "sessions", "workspaces", "locale", "uiConversation"],
      apply(ctx) {
        pluginCtx = ctx;

        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), "dsh-rewind: locale");

        ctx.effect(() => {
          const style = document.createElement("style");
          style.textContent = [
            ".rc-icon-btn{transition:background .15s ease,opacity .15s ease,color .15s ease}",
            ".rc-icon-btn:hover{background:color-mix(in srgb, currentColor 14%, transparent);opacity:1}",
            ".rc-icon-btn:active{transform:scale(.92)}",
            ".rc-icon-btn:disabled{opacity:.3;cursor:default}"
          ].join("");
          document.head.appendChild(style);
          return () => style.remove();
        }, "dsh-rewind: icon styles");

        ctx.effect(() => ctx.uiConversation.events.register(rewindDefinition), "dsh-rewind: chat row definition");

        ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
          name: "conversation.chat.node",
          key: "dsh-rewind-actions",
          locale: NS,
          inject: (sessionId) => ({ sessionId })
        }, (p) => guardSlot("conversation.chat.node", QuestionActions({ ...p, ctx }))));

        ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
          name: "conversation.input.left", id: "dsh-rewind-phrases", order: 100, locale: NS, inject: (sessionId) => ({ sessionId })
        }, (p) => guardSlot("conversation.input.left", PhrasePanel({ ...p, ctx }))));

        ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
          name: "conversation.input.left", id: "dsh-rewind-continue", order: 101, locale: NS, inject: (sessionId) => ({ sessionId })
        }, (p) => guardSlot("conversation.input.left", ContinueButton({ ...p, ctx }))));

        ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
          name: "conversation.input.left", id: "dsh-rewind-history", order: 102, locale: NS, inject: (sessionId) => ({ sessionId })
        }, (p) => guardSlot("conversation.input.left", HistoryButton({ ...p, ctx }))));

        ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
          name: "conversation.input.left", id: "dsh-rewind-stars", order: 103, locale: NS, inject: (sessionId) => ({ sessionId })
        }, (p) => guardSlot("conversation.input.left", StarPanel({ ...p, ctx }))));

        ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
          name: "conversation.input.left", id: "dsh-rewind-companion", order: 90, locale: NS, inject: (sessionId) => ({ sessionId })
        }, (p) => guardSlot("conversation.input.left", Companion({ ...p, ctx }))));

        ctx.effect(() => {
          const onKey = (e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            const sid = currentSessionId;
            if (sid == null) return;
            const hist = historyCache.get(sid) ?? loadHistory(sid);
            if (hist.length === 0) return;
            const focused = safeCompute(null, () => document.activeElement);
            if (focused === null || focused === undefined) return;
            const editable = focused.tagName === "TEXTAREA" || focused.tagName === "INPUT"
              || focused.isContentEditable === true
              || safeCompute(false, () => focused.getAttribute("role") === "textbox")
              || safeCompute(false, () => focused.getAttribute("contenteditable") === "true");
            if (!editable) return;
            const empty = safeCompute(false, () => {
              const raw = focused.value !== undefined ? focused.value : focused.textContent;
              return (raw ?? "").trim() === "";
            });
            if (!empty) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "ArrowUp") historyIndex = historyIndex < 0 ? hist.length - 1 : Math.max(0, historyIndex - 1);
            else historyIndex = historyIndex < 0 ? hist.length - 1 : Math.min(hist.length - 1, historyIndex + 1);
            const text = hist[historyIndex];
            if (text !== undefined) setDraftNow(sid, text);
          };
          document.addEventListener("keydown", onKey, true);
          return () => document.removeEventListener("keydown", onKey, true);
        }, "dsh-rewind: input history keys");
      }
    };
  }
});
