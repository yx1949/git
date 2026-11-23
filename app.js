/* =========================================================
   马克笔记 · 界面与交互
   ========================================================= */

(function () {
  "use strict";

  var ACTIVE_NOTE_KEY = "marknotes.active.v1";
  var THEME_KEY = "marknotes.theme";
  var SAVE_DELAY = 420;
  var WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  var SVG_NS = "http://www.w3.org/2000/svg";

  var dom = {
    app: document.getElementById("app"),
    noteList: document.getElementById("note-list"),
    notesRegion: document.querySelector(".notes-region"),
    notesEmpty: document.getElementById("notes-empty"),
    searchEmpty: document.getElementById("search-empty"),
    listTitle: document.getElementById("list-title"),
    noteCount: document.getElementById("note-count"),
    newNoteButton: document.getElementById("new-note-button"),
    searchField: document.getElementById("search-field"),
    searchInput: document.getElementById("search-input"),
    clearSearchButton: document.getElementById("clear-search-button"),
    clearSearchEmpty: document.getElementById("clear-search-empty"),
    themeToggle: document.getElementById("theme-toggle"),
    sidebarFooter: document.querySelector(".sidebar-footer"),
    storageLabel: document.getElementById("storage-label"),
    editorView: document.getElementById("editor-view"),
    emptyView: document.getElementById("empty-view"),
    emptyNewNote: document.getElementById("empty-new-note"),
    editorScroll: document.getElementById("editor-scroll"),
    editorSheet: document.querySelector(".editor-sheet"),
    noteTitle: document.getElementById("note-title"),
    noteContent: document.getElementById("note-content"),
    noteDate: document.getElementById("note-date"),
    wordCount: document.getElementById("note-word-count"),
    saveStatus: document.getElementById("save-status"),
    saveLabel: document.getElementById("save-label"),
    pinButton: document.getElementById("pin-button"),
    deleteButton: document.getElementById("delete-button"),
    backButton: document.getElementById("back-button"),
    deleteDialog: document.getElementById("delete-dialog"),
    deleteNoteName: document.getElementById("delete-note-name"),
    cancelDeleteButton: document.getElementById("cancel-delete-button"),
    confirmDeleteButton: document.getElementById("confirm-delete-button"),
    toast: document.getElementById("toast"),
    themeColorMeta: document.querySelector('meta[name="theme-color"]')
  };

  var store = null;
  var activeNoteId = null;
  var query = "";
  var draft = null;
  var saveTimer = 0;
  var toastTimer = 0;
  var pendingDeleteId = null;
  var resizeFrame = 0;

  /* -------------------------------------------------------
     Small helpers
     ------------------------------------------------------- */

  function isMobileLayout() {
    return window.matchMedia("(max-width: 860px)").matches;
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function readLocal(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeLocal(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  function removeLocal(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      // Storage may be unavailable. The interface still works in memory.
    }
  }

  function displayTitle(note) {
    if (!note) {
      return "无标题笔记";
    }
    var title = note.title.replace(/\s+/g, " ").trim();
    return title || "无标题笔记";
  }

  function excerptOf(note) {
    var content = note.content.replace(/\s+/g, " ").trim();
    if (!content) {
      return "还没有写下内容";
    }
    return content.length > 110 ? content.slice(0, 110) + "…" : content;
  }

  function countCharacters(text) {
    return Array.from(text.replace(/\s/g, "")).length;
  }

  function wordCountText(text) {
    return countCharacters(text) + " 字";
  }

  function startOfDay(timestamp) {
    var date = new Date(timestamp);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }

  function formatListDate(timestamp) {
    var date = new Date(timestamp);
    var now = new Date();
    var dayDifference = Math.round((startOfDay(now.getTime()) - startOfDay(timestamp)) / 86400000);

    if (dayDifference === 0) {
      return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
    }
    if (dayDifference === 1) {
      return "昨天";
    }
    if (dayDifference > 1 && dayDifference < 7) {
      return WEEKDAYS[date.getDay()];
    }
    if (date.getFullYear() === now.getFullYear()) {
      return date.getMonth() + 1 + "月" + date.getDate() + "日";
    }
    return date.getFullYear() + "/" + (date.getMonth() + 1) + "/" + date.getDate();
  }

  function formatEditorDate(timestamp) {
    var date = new Date(timestamp);
    return (
      date.getFullYear() +
      "年" +
      (date.getMonth() + 1) +
      "月" +
      date.getDate() +
      "日 " +
      WEEKDAYS[date.getDay()] +
      " · " +
      pad2(date.getHours()) +
      ":" +
      pad2(date.getMinutes())
    );
  }

  function createIcon(name, className) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "icon" + (className ? " " + className : ""));
    svg.setAttribute("aria-hidden", "true");
    var use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", "#icon-" + name);
    svg.appendChild(use);
    return svg;
  }

  function setActiveNoteId(noteId) {
    activeNoteId = noteId;
    if (noteId) {
      writeLocal(ACTIVE_NOTE_KEY, noteId);
    } else {
      removeLocal(ACTIVE_NOTE_KEY);
    }
  }

  function rememberActiveNote() {
    if (activeNoteId) {
      writeLocal(ACTIVE_NOTE_KEY, activeNoteId);
    } else {
      removeLocal(ACTIVE_NOTE_KEY);
    }
  }

  function setSaveState(state, label) {
    dom.saveStatus.dataset.state = state;
    dom.saveLabel.textContent =
      label ||
      (state === "saving" ? "保存中…" : state === "error" ? "未能保存" : "已保存");
  }

  function updateStorageHint() {
    var available = Boolean(store && store.persistent);
    dom.sidebarFooter.classList.toggle("is-storage-warning", !available);
    dom.storageLabel.textContent = available ? "本地自动保存" : "临时保存 · 请勿关闭";
    dom.storageLabel.title = available
      ? "笔记保存在当前浏览器的本地存储中"
      : "浏览器存储不可用，内容仅在本次打开期间保留";
  }

  function syncSavedState() {
    if (!store) {
      return;
    }
    if (store.persistent) {
      setSaveState("saved", "已保存");
    } else {
      setSaveState("error", "仅临时保存");
    }
    updateStorageHint();
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    dom.toast.textContent = message;
    dom.toast.classList.remove("is-visible");

    // Force a style flush so repeated messages replay the entrance transition.
    void dom.toast.offsetWidth;
    dom.toast.classList.add("is-visible");

    toastTimer = window.setTimeout(function () {
      dom.toast.classList.remove("is-visible");
    }, 2600);
  }

  function setShortcutLabels() {
    var platform = "";
    try {
      platform =
        (navigator.userAgentData && navigator.userAgentData.platform) ||
        navigator.platform ||
        navigator.userAgent ||
        "";
    } catch (error) {
      platform = "";
    }

    var isMac = /Mac|iPhone|iPad|iPod/i.test(platform);
    var prefix = isMac ? "⌘ " : "Ctrl ";
    var labels = {
      // Ctrl+N / ⌘N is reserved by many browsers, so new-note uses Alt+N.
      new: (isMac ? "⌥ " : "Alt ") + "N",
      search: prefix + "K",
      save: prefix + "S"
    };

    document.querySelectorAll("[data-shortcut]").forEach(function (element) {
      var name = element.getAttribute("data-shortcut");
      if (labels[name]) {
        element.textContent = labels[name];
      }
    });
  }

  /* -------------------------------------------------------
     Theme
     ------------------------------------------------------- */

  function updateThemeButton(theme) {
    var nextLabel = theme === "dark" ? "切换到浅色模式" : "切换到深色模式";
    dom.themeToggle.setAttribute("aria-label", nextLabel);
    dom.themeToggle.title = nextLabel;
    if (dom.themeColorMeta) {
      dom.themeColorMeta.setAttribute("content", theme === "dark" ? "#171511" : "#f4f1ea");
    }
  }

  function applyTheme(theme, persist) {
    document.documentElement.dataset.theme = theme;
    updateThemeButton(theme);
    if (persist) {
      writeLocal(THEME_KEY, theme);
    }
  }

  function initTheme() {
    var theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    applyTheme(theme, false);

    if (window.matchMedia) {
      var colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
      var handleSchemeChange = function (event) {
        if (!readLocal(THEME_KEY)) {
          applyTheme(event.matches ? "dark" : "light", false);
        }
      };
      if (typeof colorSchemeQuery.addEventListener === "function") {
        colorSchemeQuery.addEventListener("change", handleSchemeChange);
      }
    }
  }

  /* -------------------------------------------------------
     Editor sizing
     ------------------------------------------------------- */

  function autosizeTitle() {
    dom.noteTitle.style.height = "auto";
    dom.noteTitle.style.height = Math.max(dom.noteTitle.scrollHeight, 38) + "px";
  }

  function autosizeContent() {
    dom.noteContent.style.height = "auto";
    dom.noteContent.style.height = dom.noteContent.scrollHeight + "px";
  }

  function resizeEditors() {
    autosizeTitle();
    autosizeContent();
  }

  function scheduleEditorResize() {
    if (resizeFrame) {
      return;
    }
    resizeFrame = window.requestAnimationFrame(function () {
      resizeFrame = 0;
      if (!dom.editorView.hidden) {
        resizeEditors();
      }
    });
  }

  /* -------------------------------------------------------
     Rendering
     ------------------------------------------------------- */

  function buildNoteItem(note) {
    var item = document.createElement("li");
    var button = document.createElement("button");
    button.type = "button";
    button.className = "note-item";
    button.dataset.noteId = note.id;
    button.setAttribute(
      "aria-label",
      (note.pinned ? "置顶笔记，" : "") +
        displayTitle(note) +
        "，最后编辑于" +
        formatEditorDate(note.updatedAt)
    );

    if (note.id === activeNoteId) {
      button.setAttribute("aria-current", "page");
    }

    var heading = document.createElement("span");
    heading.className = "note-item-head";

    var title = document.createElement("span");
    title.className = "note-item-title";
    title.textContent = displayTitle(note);
    heading.appendChild(title);

    if (note.pinned) {
      heading.appendChild(createIcon("pin", "note-item-pin"));
    }

    var date = document.createElement("span");
    date.className = "note-item-date";
    date.textContent = formatListDate(note.updatedAt);
    heading.appendChild(date);

    var excerpt = document.createElement("span");
    excerpt.className = "note-item-excerpt";
    if (!note.content.trim()) {
      excerpt.classList.add("is-empty");
    }
    excerpt.textContent = excerptOf(note);

    button.appendChild(heading);
    button.appendChild(excerpt);
    item.appendChild(button);
    return item;
  }

  function findNoteButton(noteId) {
    if (!noteId) {
      return null;
    }
    var buttons = dom.noteList.querySelectorAll(".note-item");
    for (var index = 0; index < buttons.length; index += 1) {
      if (buttons[index].dataset.noteId === noteId) {
        return buttons[index];
      }
    }
    return null;
  }

  function restoreListFocus(noteId) {
    var button = findNoteButton(noteId);
    if (button) {
      button.focus({ preventScroll: true });
    }
  }

  function renderNoteList(options) {
    options = options || {};
    var focusedItem =
      document.activeElement && document.activeElement.closest
        ? document.activeElement.closest(".note-item")
        : null;
    var focusedNoteId = focusedItem ? focusedItem.dataset.noteId : null;
    var previousScrollTop = dom.notesRegion.scrollTop;
    var hasQuery = Boolean(query.trim());
    var notes = store.list(query);
    var total = store.count();

    dom.noteList.textContent = "";
    notes.forEach(function (note) {
      dom.noteList.appendChild(buildNoteItem(note));
    });

    dom.listTitle.textContent = hasQuery ? "搜索结果" : "全部笔记";
    dom.noteCount.textContent = String(hasQuery ? notes.length : total);
    dom.noteCount.setAttribute(
      "aria-label",
      hasQuery ? "找到 " + notes.length + " 篇笔记" : "共 " + total + " 篇笔记"
    );
    dom.notesEmpty.hidden = !(total === 0 && !hasQuery);
    dom.searchEmpty.hidden = !(hasQuery && notes.length === 0);
    dom.clearSearchButton.hidden = query.length === 0;
    dom.searchField.classList.toggle("has-query", query.length > 0);

    dom.notesRegion.scrollTop = previousScrollTop;

    if (focusedNoteId && !(isMobileLayout() && dom.app.classList.contains("is-editor-open"))) {
      restoreListFocus(focusedNoteId);
    }

    if (options.scrollToActive) {
      var activeButton = findNoteButton(activeNoteId);
      if (activeButton) {
        activeButton.scrollIntoView({ block: "nearest" });
      }
    }
  }

  function updateEditorMeta(note) {
    dom.noteDate.textContent = formatEditorDate(note.updatedAt);
    dom.wordCount.textContent = wordCountText(dom.noteContent.value);
    document.title = displayTitle(note) + " · 马克笔记";
  }

  function updatePinButton(note) {
    var pinned = Boolean(note && note.pinned);
    dom.pinButton.setAttribute("aria-pressed", pinned ? "true" : "false");
    dom.pinButton.setAttribute("aria-label", pinned ? "取消置顶" : "置顶笔记");
    dom.pinButton.title = pinned ? "取消置顶" : "置顶笔记";
  }

  function renderEditor(options) {
    options = options || {};
    var note = activeNoteId ? store.get(activeNoteId) : null;

    if (!note) {
      if (activeNoteId !== null) {
        setActiveNoteId(null);
      }
      dom.editorView.hidden = true;
      dom.emptyView.hidden = false;
      dom.app.classList.remove("is-editor-open");
      document.title = "马克笔记 · MARK NOTES";
      return;
    }

    dom.emptyView.hidden = true;
    dom.editorView.hidden = false;
    dom.noteTitle.value = note.title;
    dom.noteContent.value = note.content;
    updateEditorMeta(note);
    updatePinButton(note);
    syncSavedState();
    dom.pinButton.disabled = false;
    dom.deleteButton.disabled = false;

    if (options.scrollToTop !== false) {
      dom.editorScroll.scrollTop = 0;
    }

    resizeEditors();
    scheduleEditorResize();
  }

  function renderApp() {
    renderNoteList({ scrollToActive: true });
    renderEditor();
  }

  /* -------------------------------------------------------
     Search
     ------------------------------------------------------- */

  function applySearch(value) {
    query = value;
    renderNoteList({ scrollToActive: true });
  }

  function clearSearch(options) {
    options = options || {};
    query = "";
    dom.searchInput.value = "";
    renderNoteList({ scrollToActive: true });

    if (options.focus !== false) {
      dom.searchInput.focus();
    }
  }

  function focusSearch() {
    if (draft) {
      commitDraft({ skipList: true });
    }
    if (isMobileLayout() && dom.app.classList.contains("is-editor-open")) {
      dom.app.classList.remove("is-editor-open");
    }
    window.requestAnimationFrame(function () {
      dom.searchInput.focus();
      dom.searchInput.select();
    });
  }

  /* -------------------------------------------------------
     Saving
     ------------------------------------------------------- */

  function flushPendingDraft() {
    window.clearTimeout(saveTimer);
    saveTimer = 0;

    if (!draft || !activeNoteId) {
      draft = null;
      return null;
    }

    var noteId = activeNoteId;
    var payload = draft;
    draft = null;
    return store.update(noteId, payload);
  }

  function commitDraft(options) {
    options = options || {};
    var updatedNote = flushPendingDraft();

    if (!updatedNote) {
      return null;
    }

    if (!options.skipList) {
      renderNoteList();
    }

    if (!options.silent) {
      if (activeNoteId && store.get(activeNoteId)) {
        updateEditorMeta(updatedNote);
        updatePinButton(updatedNote);
      }
      syncSavedState();
    }

    return updatedNote;
  }

  function scheduleDraft() {
    if (!activeNoteId) {
      return;
    }

    draft = {
      title: dom.noteTitle.value,
      content: dom.noteContent.value
    };
    setSaveState("saving", "保存中…");

    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(function () {
      saveTimer = 0;
      commitDraft();
    }, SAVE_DELAY);
  }

  function saveImmediately(showFeedback) {
    if (draft) {
      commitDraft();
    } else {
      syncSavedState();
    }

    if (showFeedback) {
      showToast(store.persistent ? "已保存到本机" : "当前环境无法持久保存");
    }
  }

  /* -------------------------------------------------------
     Selection and CRUD
     ------------------------------------------------------- */

  function openEditorView() {
    dom.app.classList.add("is-editor-open");
    if (!dom.editorView.hidden) {
      scheduleEditorResize();
    }
  }

  function selectNote(noteId) {
    var note = store.get(noteId);
    if (!note) {
      return;
    }

    if (noteId === activeNoteId) {
      if (isMobileLayout()) {
        openEditorView();
        window.requestAnimationFrame(function () {
          dom.backButton.focus({ preventScroll: true });
        });
      }
      return;
    }

    commitDraft({ silent: true, skipList: true });
    setActiveNoteId(noteId);
    renderNoteList({ scrollToActive: true });
    renderEditor();

    if (isMobileLayout()) {
      openEditorView();
      window.requestAnimationFrame(function () {
        dom.backButton.focus({ preventScroll: true });
      });
    }
  }

  function createNote() {
    commitDraft({ silent: true, skipList: true });
    var note = store.create();

    query = "";
    dom.searchInput.value = "";
    setActiveNoteId(note.id);
    renderNoteList({ scrollToActive: true });
    renderEditor();

    if (isMobileLayout()) {
      openEditorView();
    }

    window.requestAnimationFrame(function () {
      dom.noteTitle.focus();
      var length = dom.noteTitle.value.length;
      try {
        dom.noteTitle.setSelectionRange(length, length);
      } catch (error) {
        // setSelectionRange is not available in a few embedded browsers.
      }
      autosizeTitle();
    });

    updateStorageHint();
    if (!store.persistent) {
      setSaveState("error", "仅临时保存");
    }
  }

  function leaveEditor(options) {
    options = options || {};
    commitDraft({ silent: true, skipList: true });
    dom.app.classList.remove("is-editor-open");

    window.requestAnimationFrame(function () {
      if (options.focusSearch) {
        dom.searchInput.focus();
        return;
      }
      var activeButton = findNoteButton(activeNoteId);
      if (activeButton) {
        activeButton.focus({ preventScroll: true });
      } else {
        dom.newNoteButton.focus({ preventScroll: true });
      }
    });
  }

  /* -------------------------------------------------------
     Pin / delete
     ------------------------------------------------------- */

  function togglePin() {
    if (!activeNoteId) {
      return;
    }

    commitDraft({ silent: true, skipList: true });
    var note = store.togglePin(activeNoteId);
    if (!note) {
      return;
    }

    renderNoteList({ scrollToActive: true });
    updatePinButton(note);
    updateEditorMeta(note);
    syncSavedState();
    showToast(note.pinned ? "已置顶这篇笔记" : "已取消置顶");
  }

  function requestDelete() {
    if (!activeNoteId) {
      return;
    }

    commitDraft({ silent: true, skipList: true });
    var note = store.get(activeNoteId);
    if (!note) {
      return;
    }

    pendingDeleteId = activeNoteId;
    dom.deleteNoteName.textContent = displayTitle(note);
    if (typeof dom.deleteDialog.showModal === "function") {
      dom.deleteDialog.showModal();
    } else {
      confirmDelete();
    }
  }

  function cancelDelete() {
    pendingDeleteId = null;
    if (dom.deleteDialog.open) {
      dom.deleteDialog.close();
    }
  }

  function confirmDelete() {
    var noteId = pendingDeleteId;
    if (!noteId) {
      return;
    }

    var deletedNote = store.get(noteId);
    if (!deletedNote) {
      cancelDelete();
      return;
    }

    var hasQuery = Boolean(query.trim());
    var visibleNotes = store.list(query);
    var deletedTitle = displayTitle(deletedNote);
    var visibleIndex = visibleNotes.findIndex(function (note) {
      return note.id === noteId;
    });
    var preferredNextId = null;

    if (visibleNotes[visibleIndex + 1]) {
      preferredNextId = visibleNotes[visibleIndex + 1].id;
    } else if (visibleNotes[visibleIndex - 1]) {
      preferredNextId = visibleNotes[visibleIndex - 1].id;
    }

    var removed = store.remove(noteId);
    if (!removed) {
      cancelDelete();
      return;
    }

    pendingDeleteId = null;
    if (dom.deleteDialog.open) {
      dom.deleteDialog.close();
    }

    var nextId = preferredNextId && store.get(preferredNextId) ? preferredNextId : null;

    if (!nextId) {
      var allNotes = store.list();
      if (allNotes.length > 0) {
        if (hasQuery) {
          query = "";
          dom.searchInput.value = "";
        }
        nextId = allNotes[0].id;
      }
    }

    setActiveNoteId(nextId);
    renderNoteList({ scrollToActive: true });
    renderEditor();
    updateStorageHint();
    showToast("已删除「" + deletedTitle + "」");

    window.setTimeout(function () {
      if (isMobileLayout()) {
        dom.app.classList.remove("is-editor-open");
      }
      var target = findNoteButton(activeNoteId) || dom.newNoteButton;
      target.focus({ preventScroll: true });
    }, 0);
  }

  /* -------------------------------------------------------
     Events
     ------------------------------------------------------- */

  function bindOpeningEvents() {
    dom.newNoteButton.addEventListener("click", createNote);
    dom.emptyNewNote.addEventListener("click", createNote);

    dom.noteList.addEventListener("click", function (event) {
      var button = event.target.closest(".note-item");
      if (!button) {
        return;
      }
      selectNote(button.dataset.noteId);
    });

    dom.searchInput.addEventListener("input", function () {
      applySearch(dom.searchInput.value);
    });

    dom.searchInput.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && dom.searchInput.value) {
        event.preventDefault();
        clearSearch();
      }
    });

    dom.clearSearchButton.addEventListener("click", function () {
      clearSearch();
    });
    dom.clearSearchEmpty.addEventListener("click", function () {
      clearSearch();
    });

    dom.backButton.addEventListener("click", function () {
      leaveEditor({});
    });

    dom.themeToggle.addEventListener("click", function () {
      handleGlobalThemeClick();
    });

    dom.noteTitle.addEventListener("input", function () {
      var value = dom.noteTitle.value;
      if (/[\r\n]/.test(value)) {
        var caret = dom.noteTitle.selectionStart;
        var beforeCaret = value.slice(0, caret);
        var removedBeforeCaret = (beforeCaret.match(/\r\n|\r|\n/g) || []).length;
        var cleaned = value.replace(/\r\n|\r|\n/g, " ");
        var newCaret = Math.max(0, caret - removedBeforeCaret);
        dom.noteTitle.value = cleaned;
        try {
          dom.noteTitle.setSelectionRange(newCaret, newCaret);
        } catch (error) {
          // Ignore selection support differences.
        }
        value = cleaned;
      }
      autosizeTitle();
      scheduleDraft();
    });

    dom.noteTitle.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        dom.noteContent.focus();
      }
    });

    dom.noteContent.addEventListener("input", function () {
      autosizeContent();
      scheduleDraft();
    });

    dom.pinButton.addEventListener("click", togglePin);
    dom.deleteButton.addEventListener("click", requestDelete);
    dom.cancelDeleteButton.addEventListener("click", cancelDelete);
    dom.confirmDeleteButton.addEventListener("click", confirmDelete);

    dom.deleteDialog.addEventListener("close", function () {
      // A new confirmation can be opened before the previous close event is
      // dispatched. Only clear the pending note if the dialog is really closed.
      if (!dom.deleteDialog.open) {
        pendingDeleteId = null;
      }
    });

    dom.deleteDialog.addEventListener("click", function (event) {
      if (event.target === dom.deleteDialog) {
        cancelDelete();
      }
    });

    window.addEventListener("pagehide", function () {
      flushPendingDraft();
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden" && draft) {
        commitDraft({ silent: true, skipList: true });
      }
    });

    window.addEventListener("resize", scheduleEditorResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", scheduleEditorResize);
    }

    document.addEventListener("keydown", handleShortcuts);
  }

  function handleGlobalThemeClick() {
    var nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme, true);
  }

  function handleShortcuts(event) {
    if (event.defaultPrevented || event.isComposing || dom.deleteDialog.open) {
      return;
    }

    var key = String(event.key || "").toLowerCase();
    var hasCommandModifier = event.ctrlKey || event.metaKey;

    // Alt+N is reliable in browsers that reserve Ctrl/Cmd+N for a new window.
    if (event.altKey && !hasCommandModifier && !event.shiftKey && key === "n") {
      event.preventDefault();
      if (!event.repeat) {
        createNote();
      }
      return;
    }

    if (!hasCommandModifier || event.altKey || event.shiftKey) {
      return;
    }

    if (key === "n") {
      // Kept as a best-effort shortcut for browsers that let pages receive it.
      event.preventDefault();
      if (!event.repeat) {
        createNote();
      }
      return;
    }

    if (key === "k") {
      event.preventDefault();
      if (!event.repeat) {
        focusSearch();
      }
      return;
    }

    if (key === "s") {
      event.preventDefault();
      if (!event.repeat) {
        saveImmediately(true);
      }
    }
  }

  /* -------------------------------------------------------
     Boot
     ------------------------------------------------------- */

  function init() {
    initTheme();
    setShortcutLabels();

    if (!window.MarkNotesStore || !window.MarkNotesStore.NoteStore) {
      throw new Error("笔记数据层未能加载");
    }

    store = new window.MarkNotesStore.NoteStore();

    var notes = store.list();
    var rememberedId = readLocal(ACTIVE_NOTE_KEY);
    var rememberedNote = rememberedId ? store.get(rememberedId) : null;

    if (rememberedNote) {
      activeNoteId = rememberedNote.id;
    } else if (notes.length > 0) {
      activeNoteId = notes[0].id;
      rememberActiveNote();
    }

    bindOpeningEvents();
    updateStorageHint();
    renderApp();

    if (activeNoteId) {
      rememberActiveNote();
    }

    syncSavedState();
    document.documentElement.dataset.appReady = "true";
  }

  init();
})();
