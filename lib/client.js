/**
 * @dsh-session-delete-menu — Client half.
 *
 * Exactly two features, nothing else:
 *
 *   1. A red "删除对话" row in the sidebar session context menu
 *      (`sidebar.workspaces.session.menu.item`, order 500, right after DSH's
 *      own archive row), with a two-step confirmation.
 *   2. Multi-select: a "多选…" row enters selection mode, clicking a session
 *      row toggles it, and a bottom action bar batch-archives, unarchives or
 *      deletes the selected conversations.
 *
 * Both go to this plugin's own host endpoints. No other third-party plugin is
 * involved, and the plugin adds no rename / pin / move / other action.
 *
 * No build step: DSH loads this file as a Cordis client bundle through the
 * `dsh.client` declaration in package.json.
 */
window.__ModuleLoader__.load({
  id: "dsh-session-delete-menu",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = (type, props, ...children) => React.createElement(type, props, ...children);

    const API = "/session-delete/api";
    const STYLE_ID = "dsm-delete-menu-style";
    const ROW_SELECTOR = '[data-row-key^="session:"]';
    const ROW_PREFIX = "session:";

    // ------------------------------------------------------------------ styles

    function ensureStyles() {
      if (typeof document === "undefined" || !document.head) return;
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = [
        ".dsm-delete-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;",
        "min-height:30px;padding:0 10px;margin:0;border:0;border-radius:6px;background:transparent;",
        "color:#ff6b6b;font-size:13px;font-family:inherit;line-height:1.2;text-align:left;cursor:pointer;",
        "transition:background-color .12s ease,color .12s ease;}",
        ".dsm-delete-item:hover{background:rgba(255,86,86,.14);}",
        ".dsm-delete-item:active{background:rgba(255,86,86,.24);}",
        ".dsm-delete-item:focus-visible{outline:2px solid rgba(255,86,86,.5);outline-offset:1px;}",
        ".dsm-delete-item .dsm-delete-icon{display:inline-flex;flex:none;}",
        ".dsm-delete-item .dsm-delete-label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
        ".dsm-multi-item{color:inherit;}",
        ".dsm-multi-item:hover{background:rgba(255,255,255,.08);}",
        ".dsm-multi-item .dsm-delete-icon{display:inline-flex;flex:none;}",
        ".dsm-multi-item .dsm-delete-label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
        "[data-row-key^=\"session:\"].dsm-multi-row{cursor:pointer;}",
        "[data-row-key^=\"session:\"].dsm-row-selected{background:rgba(255,86,86,.13) !important;",
        "box-shadow:inset 2px 0 0 #ff6b6b;}",
        ".dsm-multibar{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;",
        "display:flex;flex-wrap:wrap;align-items:center;gap:8px;max-width:calc(100vw - 32px);",
        "box-sizing:border-box;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.14);",
        "background:rgba(28,28,32,.94);color:#f2f2f4;font:13px/1.4 inherit;",
        "box-shadow:0 12px 40px rgba(0,0,0,.42);backdrop-filter:blur(8px);}",
        ".dsm-multibar-count{min-width:74px;padding:0 4px;color:#ffb3b3;font-variant-numeric:tabular-nums;}",
        ".dsm-multibar button{appearance:none;min-height:30px;padding:0 12px;border:1px solid rgba(255,255,255,.18);",
        "border-radius:7px;background:rgba(255,255,255,.08);color:#f2f2f4;font:inherit;cursor:pointer;",
        "transition:background-color .12s ease,border-color .12s ease;}",
        ".dsm-multibar button:hover{background:rgba(255,255,255,.16);}",
        ".dsm-multibar button:focus-visible{outline:2px solid rgba(255,255,255,.5);outline-offset:1px;}",
        ".dsm-multibar button[data-act=\"delete\"]{border-color:rgba(255,86,86,.6);background:rgba(255,86,86,.18);color:#ffd6d6;}",
        ".dsm-multibar button[data-act=\"delete\"]:hover{background:rgba(255,86,86,.3);}",
        ".dsm-multibar button[data-act=\"exit\"]{border-color:transparent;background:transparent;color:#a8a8b2;}"
      ].join("\n");
      document.head.appendChild(style);
    }

    /** 14px trash glyph, drawn inline so it needs no icon package. */
    function TrashIcon() {
      return h("svg", {
        width: 14,
        height: 14,
        viewBox: "0 0 16 16",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 1.4,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true"
      },
        h("path", { d: "M3.5 4.5h9" }),
        h("path", { d: "M6.4 4.5V3.1h3.2v1.4" }),
        h("path", { d: "M5.2 4.5v8.3a1 1 0 0 0 1 1h3.6a1 1 0 0 0 1-1V4.5" }),
        h("path", { d: "M6.9 7.1v4.3M9.1 7.1v4.3" })
      );
    }

    /** 14px checklist glyph for the multi-select row. */
    function CheckListIcon() {
      return h("svg", {
        width: 14,
        height: 14,
        viewBox: "0 0 16 16",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 1.4,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true"
      },
        h("rect", { x: 2.2, y: 2.2, width: 11.6, height: 11.6, rx: 2 }),
        h("path", { d: "M5.2 8.1l1.7 1.7 3.6-3.6" })
      );
    }

    // ------------------------------------------------------------------- http

    async function readJson(response) {
      try { return await response.json(); } catch (_) { return null; }
    }

    async function postJson(path, payload) {
      try {
        const response = await fetch(API + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(payload)
        });
        const data = await readJson(response);
        if (data && typeof data === "object") {
          if (!response.ok && data.ok !== false) return { ok: false, error: "HTTP " + response.status };
          return data;
        }
        return { ok: false, error: "HTTP " + response.status };
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    }

    function sideNameFor(archived) {
      return archived ? "归档" : "取消归档";
    }

    /** Surface per-session failures instead of silently reporting success. */
    function reportBatch(data, verb) {
      if (!data || data.ok === false || !data.result) {
        window.alert(verb + "失败：" + ((data && data.error) || "未知错误"));
        return;
      }
      const failed = Array.isArray(data.result.failed) ? data.result.failed : [];
      if (failed.length > 0) {
        const lines = failed.map((item) => "· " + item.sessionId + "：" + item.error).join("\n");
        window.alert(verb + "完成，" + failed.length + " 段失败：\n" + lines);
      }
    }

    // -------------------------------------------------------------- selection

    const multi = { active: false, selected: new Set() };
    const subscribers = new Set();
    let bar = null;
    let observer = null;
    let syncTimer = null;
    let listening = false;

    function notify() {
      for (const fn of subscribers) {
        try { fn(); } catch (_) { /* a stale subscriber must not block the rest */ }
      }
    }

    function subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    }

    function rowElements() {
      if (typeof document === "undefined") return [];
      return Array.from(document.querySelectorAll(ROW_SELECTOR));
    }

    function rowSessionId(element) {
      const key = element && element.getAttribute ? element.getAttribute("data-row-key") : "";
      return typeof key === "string" && key.indexOf(ROW_PREFIX) === 0 ? key.slice(ROW_PREFIX.length) : "";
    }

    function titleOf(sessionId) {
      const element = typeof document === "undefined" ? null
        : document.querySelector('[data-row-key="' + ROW_PREFIX + sessionId + '"]');
      if (!element) return "";
      const title = element.querySelector("span[class*=\"title\"]");
      return title && title.textContent ? title.textContent.trim() : "";
    }

    /** Paint (or clear) the selected state on every visible session row. */
    function syncRows() {
      for (const element of rowElements()) {
        if (!element.classList) continue;
        if (multi.active) {
          element.classList.add("dsm-multi-row");
          const id = rowSessionId(element);
          if (id !== "" && multi.selected.has(id)) element.classList.add("dsm-row-selected");
          else element.classList.remove("dsm-row-selected");
        } else {
          element.classList.remove("dsm-multi-row");
          element.classList.remove("dsm-row-selected");
        }
      }
      syncBar();
    }

    function scheduleSync() {
      if (!multi.active) return;
      if (syncTimer !== null) return;
      syncTimer = setTimeout(() => {
        syncTimer = null;
        syncRows();
      }, 250);
    }

    function syncBar() {
      if (!bar) return;
      const count = multi.selected.size;
      const counter = bar.querySelector(".dsm-multibar-count");
      if (counter) counter.textContent = "已选 " + count + " 项";
    }

    function clearSelection() {
      multi.selected.clear();
      syncRows();
      notify();
    }

    /** Toggle one row from a pointer click while selection mode is on. */
    function toggleRow(element) {
      const id = rowSessionId(element);
      if (id === "") return;
      if (multi.selected.has(id)) multi.selected.delete(id);
      else multi.selected.add(id);
      syncRows();
      notify();
    }

    function onDocumentClick(event) {
      if (!multi.active) return;
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      // Buttons stay live: the "..." menu button and row hover actions must work.
      if (target.closest("button")) return;
      const row = target.closest(ROW_SELECTOR);
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      toggleRow(row);
    }

    function startWatchingRows() {
      if (!listening && typeof document !== "undefined") {
        document.addEventListener("click", onDocumentClick, true);
        listening = true;
      }
      if (observer === null && typeof MutationObserver !== "undefined" && document.body) {
        observer = new MutationObserver(() => scheduleSync());
        // Rows are re-rendered with their own className on selection or menu
        // changes, which would drop our marker class, so class writes count too.
        // syncRows only writes a class that is genuinely missing, so this loop
        // settles immediately instead of re-triggering itself.
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class"]
        });
      }
    }

    function stopWatchingRows() {
      if (listening) {
        document.removeEventListener("click", onDocumentClick, true);
        listening = false;
      }
      if (observer !== null) {
        observer.disconnect();
        observer = null;
      }
      if (syncTimer !== null) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
    }

    // ------------------------------------------------------------------- bar

    function ensureBar() {
      if (bar || typeof document === "undefined" || !document.body) return bar;
      bar = document.createElement("div");
      bar.className = "dsm-multibar";
      bar.setAttribute("role", "toolbar");
      bar.setAttribute("aria-label", "批量操作");
      const caption = document.createElement("span");
      caption.className = "dsm-multibar-count";
      caption.textContent = "已选 0 项";
      bar.appendChild(caption);
      const buttons = [
        ["all", "全选"],
        ["none", "清空"],
        ["archive", "归档"],
        ["unarchive", "取消归档"],
        ["delete", "删除"],
        ["exit", "退出多选"]
      ];
      for (const pair of buttons) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.act = pair[0];
        button.textContent = pair[1];
        button.addEventListener("click", onBarClick);
        bar.appendChild(button);
      }
      document.body.appendChild(bar);
      return bar;
    }

    function hideBar() {
      if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
      bar = null;
    }

    function enterMulti(seedSessionId) {
      multi.active = true;
      if (typeof seedSessionId === "string" && seedSessionId !== "") multi.selected.add(seedSessionId);
      ensureStyles();
      ensureBar();
      startWatchingRows();
      syncRows();
      notify();
    }

    function exitMulti() {
      multi.active = false;
      multi.selected.clear();
      stopWatchingRows();
      hideBar();
      syncRows();
      notify();
    }

    async function onBarClick(event) {
      const button = event.currentTarget;
      const act = button && button.dataset ? button.dataset.act : "";
      if (act === "exit") {
        exitMulti();
        return;
      }
      if (act === "all") {
        for (const element of rowElements()) {
          const id = rowSessionId(element);
          if (id !== "") multi.selected.add(id);
        }
        syncRows();
        notify();
        return;
      }
      if (act === "none") {
        clearSelection();
        return;
      }
      if (act === "archive" || act === "unarchive") {
        await runBatchArchive(act === "archive");
        return;
      }
      if (act === "delete") await runBatchDelete();
    }

    async function runBatchArchive(archived) {
      const ids = Array.from(multi.selected);
      if (ids.length === 0) {
        window.alert("先选中至少一段对话");
        return;
      }
      const verb = sideNameFor(archived);
      if (!window.confirm(verb + "选中的 " + ids.length + " 段对话？")) return;
      const data = await postJson("/archive", { sessionIds: ids, archived });
      reportBatch(data, verb);
      if (data && data.ok !== false) {
        clearSelection();
        scheduleSync();
      }
    }

    async function runBatchDelete() {
      const ids = Array.from(multi.selected);
      if (ids.length === 0) {
        window.alert("先选中至少一段对话");
        return;
      }
      const text = "删除选中的 " + ids.length + " 段对话？\n\n会话记录会从磁盘移除，删除后不可恢复。"
        + "\n其中正在打开的会话会先被停止。";
      if (!window.confirm(text)) return;
      const data = await postJson("/delete", { sessionIds: ids });
      reportBatch(data, "删除");
      if (data && data.ok !== false) {
        clearSelection();
        scheduleSync();
      }
    }

    // ------------------------------------------------------------------ rows

    /** Single-session confirm, used by the context menu row. */
    async function previewSession(sessionId) {
      const fallback = { artifactCount: 0, live: false };
      try {
        const response = await fetch(API + "/preview?sessionId=" + encodeURIComponent(sessionId), {
          method: "GET",
          credentials: "same-origin"
        });
        const data = await readJson(response);
        if (data && data.ok && data.result) {
          return {
            artifactCount: typeof data.result.artifactCount === "number" ? data.result.artifactCount : 0,
            live: data.result.live === true
          };
        }
        return fallback;
      } catch (_) {
        return fallback;
      }
    }

    async function deleteSession(sessionId, displayTitle) {
      if (!sessionId) return;
      const preview = await previewSession(sessionId);
      let text = "删除对话「" + (displayTitle || sessionId) + "」？\n\n会话记录会从磁盘移除，删除后不可恢复。";
      if (preview.live) text += "\n该会话当前处于打开状态，删除会先停止它。";
      if (preview.artifactCount > 1) text += "\n该会话在 " + preview.artifactCount + " 个工作区分组下都有记录，都会一并删除。";
      if (!window.confirm(text)) return;
      const data = await postJson("/delete", { sessionId });
      if (!data || data.ok === false) {
        window.alert("删除失败：" + ((data && data.error) || "未知错误"));
      }
    }

    /** Read the menu's open-state handle so a row can close the menu it lives in. */
    function menuCloser(props) {
      try {
        const state = props && typeof props.useMenuOpenState === "function" ? props.useMenuOpenState() : null;
        if (state && typeof state[1] === "function") return state[1];
      } catch (_) { /* menu state unavailable: the row still works */ }
      return null;
    }

    function DeleteSessionMenuItem(props) {
      const sessionId = props && props.sessionId;
      const displayTitle = props && props.displayTitle;
      const closeMenu = menuCloser(props);
      return h("button", {
        type: "button",
        className: "dsm-delete-item",
        role: "menuitem",
        "aria-label": "删除对话",
        onClick: (event) => {
          try { if (event && event.stopPropagation) event.stopPropagation(); } catch (_) {}
          if (typeof closeMenu === "function") closeMenu();
          deleteSession(sessionId, displayTitle);
        }
      },
        h("span", { className: "dsm-delete-icon" }, TrashIcon()),
        h("span", { className: "dsm-delete-label" }, "删除对话")
      );
    }

    function MultiSelectMenuItem(props) {
      const sessionId = props && props.sessionId;
      const closeMenu = menuCloser(props);
      return h("button", {
        type: "button",
        className: "dsm-delete-item dsm-multi-item",
        role: "menuitem",
        "aria-label": "多选对话",
        onClick: (event) => {
          try { if (event && event.stopPropagation) event.stopPropagation(); } catch (_) {}
          if (typeof closeMenu === "function") closeMenu();
          enterMulti(sessionId);
        }
      },
        h("span", { className: "dsm-delete-icon" }, CheckListIcon()),
        h("span", { className: "dsm-delete-label" }, "多选…")
      );
    }

    // ----------------------------------------------------------------- apply

    const inject = ["slots"];

    function registerMenuRow(ctx, id, order, component, label) {
      try {
        ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
          name: "sidebar.workspaces.session.menu.item",
          id,
          order
        }, component));
      } catch (error) {
        console.warn("dsh-session-delete-menu: registering " + label + " failed", error);
      }
    }

    function apply(ctx) {
      ensureStyles();
      registerMenuRow(ctx, "session-delete", 500, DeleteSessionMenuItem, "删除对话");
      registerMenuRow(ctx, "session-multi", 510, MultiSelectMenuItem, "多选…");
      // Selection mode must not survive a page reload or a profile switch.
      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        window.addEventListener("beforeunload", () => {
          try { stopWatchingRows(); } catch (_) { /* nothing left to clean up */ }
        });
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__internal = { enterMulti, exitMulti, toggleRow, multi, titleOf };
    return module.exports;
  }
});
