"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createStaticServer } = require("../server.cjs");
const { delay, launchBrowser } = require("./browser.cjs");

const ROOT = path.resolve(__dirname, "..");
const SCREENSHOT_DIR = path.join(__dirname, "screenshots");

function listen(server) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(0, "127.0.0.1");
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function isVisible(styleValue) {
  return styleValue !== "none" && styleValue !== "hidden";
}

test(
  "马克笔记 · 浏览器端到端测试",
  { timeout: 180000 },
  async (t) => {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    const pageErrors = [];
    const consoleErrors = [];
    const server = createStaticServer(ROOT);
    let harness = null;

    try {
      await listen(server);
      const port = server.address().port;
      const baseUrl = "http://127.0.0.1:" + port;

      harness = await launchBrowser(baseUrl);
      const { page, client } = harness;

      client.on("Runtime.exceptionThrown", (params) => {
        const details = params.exceptionDetails || {};
        const description =
          (details.exception && details.exception.description) ||
          details.text ||
          "未知页面异常";
        pageErrors.push(description);
      });

      client.on("Runtime.consoleAPICalled", (params) => {
        if (params.type !== "error") {
          return;
        }
        const text = (params.args || [])
          .map((argument) => argument.value || argument.description || "")
          .join(" ");
        consoleErrors.push(text || "console.error");
      });

      client.on("Log.entryAdded", (params) => {
        const entry = params.entry || {};
        if (entry.level === "error") {
          consoleErrors.push((entry.source || "log") + ": " + (entry.text || ""));
        }
      });

      await page.setViewport(1440, 900, false);
      await page.setColorScheme("light");
      await page.navigateFresh();
      await page.waitForReady();

      async function resetApp(options = {}) {
        const mobile = Boolean(options.mobile);
        await page.setViewport(mobile ? 390 : 1440, mobile ? 844 : 900, mobile);
        await page.setColorScheme("light");
        await page.evaluate("localStorage.clear(); sessionStorage.clear();");
        await page.navigateFresh({ settle: 30 });
      }

      async function waitForNoteCount(expected) {
        await page.waitFor(
          "document.querySelectorAll('#note-list .note-item').length === " + expected,
          { message: "笔记列表数量变为 " + expected }
        );
      }

      async function listItems() {
        return page.evaluate(`Array.from(
          document.querySelectorAll("#note-list .note-item")
        ).map((button) => ({
          id: button.dataset.noteId,
          title: button.querySelector(".note-item-title").textContent,
          excerpt: button.querySelector(".note-item-excerpt").textContent,
          current: button.getAttribute("aria-current"),
          label: button.getAttribute("aria-label")
        }))`);
      }

      async function storedNotes() {
        return page.evaluate(`(() => {
          try {
            const data = JSON.parse(localStorage.getItem("marknotes.notes.v1"));
            return data ? data.notes : null;
          } catch (error) {
            return null;
          }
        })()`);
      }

      async function activeStoredId() {
        return page.evaluate("localStorage.getItem('marknotes.active.v1')");
      }

      async function openDeleteDialog() {
        await page.click("#delete-button");
        await page.waitFor("document.querySelector('#delete-dialog').open === true", {
          message: "删除确认框打开"
        });
      }

      async function waitForSaved(title, content) {
        await page.waitFor(
          `(() => {
            const status = document.querySelector("#save-status");
            if (!status || status.dataset.state !== "saved") {
              return false;
            }
            try {
              const data = JSON.parse(localStorage.getItem("marknotes.notes.v1"));
              const activeId = localStorage.getItem("marknotes.active.v1");
              const note = data.notes.find((item) => item.id === activeId);
              return Boolean(
                note &&
                note.title === ${JSON.stringify(title)} &&
                note.content === ${JSON.stringify(content)}
              );
            } catch (error) {
              return false;
            }
          })()`,
          { message: "自动保存完成", timeout: 8000 }
        );
      }

      await t.test("桌面双栏布局与首屏内容", { timeout: 30000 }, async () => {
        await resetApp();
        await waitForNoteCount(5);

        const layout = await page.evaluate(`(() => {
          const sidebar = document.querySelector(".sidebar").getBoundingClientRect();
          const workspace = document.querySelector(".workspace").getBoundingClientRect();
          const list = document.querySelector("#note-list").getBoundingClientRect();
          const title = document.querySelector("#note-title").getBoundingClientRect();
          return {
            innerWidth,
            innerHeight,
            sidebar: { left: sidebar.left, right: sidebar.right, width: sidebar.width, height: sidebar.height },
            workspace: { left: workspace.left, right: workspace.right, width: workspace.width, height: workspace.height },
            list: { left: list.left, width: list.width },
            title: { left: title.left, width: title.width, top: title.top },
            documentScrollWidth: document.documentElement.scrollWidth,
            editorHidden: document.querySelector("#editor-view").hidden,
            emptyHidden: document.querySelector("#empty-view").hidden
          };
        })()`);

        assert.equal(layout.innerWidth, 1440);
        assert.ok(layout.sidebar.width >= 300, "左侧栏应有足够宽度");
        assert.ok(layout.workspace.width >= 900, "右侧编辑区应占据剩余空间");
        assert.ok(
          Math.abs(layout.sidebar.right - layout.workspace.left) <= 1,
          "左右两栏应紧邻且没有重叠"
        );
        assert.ok(layout.sidebar.height >= 899 && layout.workspace.height >= 899);
        assert.ok(layout.title.left > layout.list.left, "笔记内容应位于列表右侧");
        assert.equal(layout.editorHidden, false);
        assert.equal(layout.emptyHidden, true);
        assert.equal(layout.documentScrollWidth, 1440, "桌面页面不应出现横向溢出");

        const items = await listItems();
        assert.equal(items.length, 5);
        assert.equal(items[0].current, "page", "首篇笔记应处于选中状态");
        assert.match(items[0].label, /^置顶笔记/);
        assert.equal(await page.value("#note-title"), "欢迎来到马克笔记");
        assert.match(await page.value("#note-content"), /这里是一页安静的数字纸张/);
        assert.equal(await page.text("#note-count"), "5");
        assert.equal(await page.attribute("#save-status", "data-state"), "saved");
        assert.equal(await page.text("#save-label"), "已保存");

        const persisted = await storedNotes();
        assert.equal(persisted.length, 5);
        assert.ok(persisted.every((note) => note.id && note.createdAt && note.updatedAt));

        await page.click("#note-list li:nth-child(2) .note-item");
        await page.waitFor("document.querySelector('#note-title').value.includes('周末书单')");
        assert.match(await page.value("#note-content"), /山茶文具店/);
        assert.equal(
          await page.attribute("#note-list li:nth-child(2) .note-item", "aria-current"),
          "page"
        );
        assert.equal(await page.count("#note-list .note-item[aria-current='page']"), 1);
      });

      await t.test("新建笔记、真实输入、自动保存与刷新恢复", { timeout: 30000 }, async () => {
        await resetApp();
        await waitForNoteCount(5);

        await page.click("#new-note-button");
        await waitForNoteCount(6);
        await page.waitFor("document.querySelector('#note-title').value === ''");
        assert.equal(
          await page.evaluate("document.activeElement === document.querySelector('#note-title')"),
          true,
          "新建笔记后应聚焦标题"
        );
        assert.equal(await page.count("#note-list .note-item[aria-current='page']"), 1);

        const title = "端到端测试笔记";
        const content = "这是通过真实输入事件写入的内容。\n第二行也要被保存。";

        await page.focus("#note-title");
        await page.typeText(title);
        await page.focus("#note-content");
        await page.typeText(content);

        await waitForSaved(title, content);

        const expectedCount = Array.from(content.replace(/\s/g, "")).length + " 字";
        assert.equal(await page.text("#note-word-count"), expectedCount);
        assert.equal(await page.text("#save-label"), "已保存");
        assert.match(await page.text("#note-date"), /2026年|202[5-9]年/);

        const activeId = await activeStoredId();
        const persisted = await storedNotes();
        const newNote = persisted.find((note) => note.id === activeId);
        assert.ok(newNote, "新笔记应已持久化");
        assert.equal(newNote.title, title);
        assert.equal(newNote.content, content);
        assert.equal(persisted.length, 6);

        const activeItem = (await listItems()).find((item) => item.id === activeId);
        assert.equal(activeItem.current, "page");
        assert.equal(activeItem.title, title);

        await page.navigateFresh();
        await page.waitForReady();
        await waitForNoteCount(6);
        assert.equal(await page.value("#note-title"), title);
        assert.equal(await page.value("#note-content"), content);
        assert.equal(await activeStoredId(), activeId);
        assert.equal(await page.text("#note-count"), "6");
        assert.equal(await page.text("#save-label"), "已保存");
      });

      await t.test("搜索标题与正文、空结果与快捷清除", { timeout: 30000 }, async () => {
        await resetApp();
        await waitForNoteCount(5);

        await page.typeInto("#search-input", "杭州");
        await page.waitFor(
          "document.querySelectorAll('#note-list .note-item').length === 1",
          { message: "搜索“杭州”后只剩一篇笔记" }
        );
        assert.equal(await page.text("#list-title"), "搜索结果");
        assert.equal(await page.text("#note-count"), "1");
        assert.match(await page.text("#note-list .note-item-title"), /杭州/);
        assert.equal(await page.evaluate("document.querySelector('#clear-search-button').hidden"), false);

        await page.typeInto("#search-input", "初稿", { replace: true });
        await page.waitFor(
          "document.querySelectorAll('#note-list .note-item').length === 1",
          { message: "正文关键词也能被搜索到" }
        );
        assert.match(await page.text("#note-list .note-item-title"), /摘录/);

        await page.typeInto("#search-input", "一个绝对不存在的关键词", { replace: true });
        await page.waitFor("document.querySelector('#search-empty').hidden === false", {
          message: "无搜索结果时展示空状态"
        });
        assert.equal(await page.count("#note-list .note-item"), 0);
        assert.equal(await page.text("#note-count"), "0");
        assert.equal(await page.evaluate("document.querySelector('#editor-view').hidden"), false);
        assert.equal(await page.value("#note-title"), "欢迎来到马克笔记");

        await page.pressKey("Escape");
        await page.waitFor(
          "document.querySelector('#search-input').value === '' && document.querySelectorAll('#note-list .note-item').length === 5",
          { message: "Escape 清除搜索并恢复列表" }
        );
        assert.equal(await page.text("#list-title"), "全部笔记");
        assert.equal(await page.evaluate("document.querySelector('#search-empty').hidden"), true);
        assert.equal(await page.evaluate("document.querySelector('#clear-search-button').hidden"), true);

        await page.typeInto("#search-input", "初稿", { replace: true });
        await page.waitFor("document.querySelectorAll('#note-list .note-item').length === 1");
        await page.click("#clear-search-button");
        await waitForNoteCount(5);
        assert.equal(await page.value("#search-input"), "");
      });

      await t.test("置顶、排序与刷新后保留", { timeout: 30000 }, async () => {
        await resetApp();
        await waitForNoteCount(5);

        await page.click("#note-list li:nth-child(2) .note-item");
        await page.waitFor("document.querySelector('#note-title').value.includes('周末书单')");
        const activeId = await activeStoredId();
        assert.equal(await page.attribute("#pin-button", "aria-pressed"), "false");

        await page.click("#pin-button");
        await page.waitFor("document.querySelector('#pin-button').getAttribute('aria-pressed') === 'true'");

        const items = await listItems();
        const activeIndex = items.findIndex((item) => item.id === activeId);
        assert.ok(activeIndex >= 0);
        assert.match(items[activeIndex].label, /^置顶笔记/);
        assert.ok(
          items.findIndex((item) => !item.label.startsWith("置顶笔记")) > activeIndex,
          "置顶笔记应排在所有普通笔记之前"
        );
        assert.match(await page.text("#toast"), /已置顶/);

        const persisted = await storedNotes();
        assert.equal(persisted.find((note) => note.id === activeId).pinned, true);

        await page.navigateFresh();
        await page.waitForReady();
        assert.equal(await page.attribute("#pin-button", "aria-pressed"), "true");
        const reloadedItems = await listItems();
        assert.equal(reloadedItems.find((item) => item.id === activeId).current, "page");
        assert.match(reloadedItems.find((item) => item.id === activeId).label, /^置顶笔记/);

        await page.click("#pin-button");
        await page.waitFor("document.querySelector('#pin-button').getAttribute('aria-pressed') === 'false'");
        const unpinned = await storedNotes();
        assert.equal(unpinned.find((note) => note.id === activeId).pinned, false);
      });

      await t.test("删除确认：取消、确认并自动选中下一篇", { timeout: 30000 }, async () => {
        await resetApp();
        await waitForNoteCount(5);
        await page.click("#note-list li:nth-child(2) .note-item");
        await page.waitFor("document.querySelector('#note-title').value.includes('周末书单')");

        const activeId = await activeStoredId();

        await openDeleteDialog();
        assert.equal(await page.text("#delete-note-name"), "周末书单：允许自己慢下来");
        assert.match(await page.text("#delete-dialog"), /永久删除/);

        await page.click("#cancel-delete-button");
        await page.waitFor("document.querySelector('#delete-dialog').open === false", {
          message: "取消后关闭对话框"
        });
        assert.equal(await page.count("#note-list .note-item"), 5);
        assert.equal(await page.value("#note-title"), "周末书单：允许自己慢下来");

        await openDeleteDialog();
        await page.click("#confirm-delete-button");
        await page.waitFor(
          "document.querySelector('#delete-dialog').open === false && document.querySelectorAll('#note-list .note-item').length === 4",
          { message: "确认删除后更新列表" }
        );

        assert.match(await page.text("#toast"), /已删除「周末书单：允许自己慢下来」/);
        assert.notEqual(await activeStoredId(), activeId);
        assert.ok(await page.value("#note-title"));
        assert.equal(await page.count("#note-list .note-item[aria-current='page']"), 1);

        const persisted = await storedNotes();
        assert.equal(persisted.length, 4);
        assert.equal(persisted.some((note) => note.id === activeId), false);
      });

      await t.test("删除全部笔记后显示空状态，刷新也不重新填充", { timeout: 40000 }, async () => {
        await resetApp();
        await waitForNoteCount(5);

        let remaining = 5;
        while (remaining > 0) {
          await openDeleteDialog();
          await page.click("#confirm-delete-button");
          remaining -= 1;
          await waitForNoteCount(remaining);
          await page.waitFor("document.querySelector('#delete-dialog').open === false");
        }

        await page.waitFor(
          "document.querySelector('#editor-view').hidden === true && document.querySelector('#empty-view').hidden === false",
          { message: "无笔记时展示空状态" }
        );
        assert.equal(await page.text("#note-count"), "0");
        assert.equal(await page.evaluate("document.querySelector('#notes-empty').hidden"), false);
        assert.equal(await page.text("#empty-title"), "留一页，给此刻。");
        assert.deepEqual(await storedNotes(), []);

        await page.navigateFresh();
        await page.waitForReady();
        await waitForNoteCount(0);
        assert.equal(await page.evaluate("document.querySelector('#empty-view').hidden"), false);
        assert.equal(await page.text("#note-count"), "0");
        assert.deepEqual(await storedNotes(), []);

        await page.click("#empty-new-note");
        await waitForNoteCount(1);
        await page.waitFor("document.querySelector('#editor-view').hidden === false");
        assert.equal(await page.value("#note-title"), "");
        assert.equal(await page.text("#note-count"), "1");
      });

      await t.test("键盘快捷键：新建、搜索与立即保存", { timeout: 30000 }, async () => {
        await resetApp();
        await waitForNoteCount(5);

        assert.match(await page.text("[data-shortcut='new']"), /Alt N/);
        await page.pressAltShortcut("N");
        await waitForNoteCount(6);
        await page.waitFor(
          "document.activeElement && document.activeElement.id === 'note-title'",
          { message: "Alt+N 后聚焦新笔记标题" }
        );

        const title = "快捷键保存的笔记";
        const content = "这段文字通过 Ctrl+S 手动保存。";
        await page.typeInto("#note-title", title, { replace: true });
        await page.typeInto("#note-content", content);
        await page.pressControlShortcut("S");

        await page.waitFor("document.querySelector('#toast').textContent.includes('已保存到本机')", {
          message: "Ctrl+S 触发手动保存提示"
        });
        const persisted = await storedNotes();
        const activeId = await activeStoredId();
        const activeNote = persisted.find((note) => note.id === activeId);
        assert.equal(activeNote.title, title, "手动保存应写入存储");
        assert.equal(activeNote.content, content);

        await page.waitFor("document.querySelector('#save-status').dataset.state === 'saved'");

        await page.pressControlShortcut("K");
        await page.waitFor(
          "document.activeElement && document.activeElement.id === 'search-input'",
          { message: "Ctrl+K 聚焦搜索框" }
        );
        await page.typeText("快捷键");
        await page.waitFor("document.querySelectorAll('#note-list .note-item').length === 1");
        assert.match(await page.text("#note-list .note-item-title"), /快捷键保存的笔记/);
      });

      await t.test("浅色/深色外观切换并持久化", { timeout: 30000 }, async () => {
        await resetApp();
        assert.equal(await page.attribute("html", "data-theme"), "light");

        await page.click("#theme-toggle");
        await page.waitFor("document.documentElement.dataset.theme === 'dark'");
        assert.equal(
          await page.evaluate("localStorage.getItem('marknotes.theme')"),
          "dark"
        );
        assert.equal(await page.attribute("#theme-toggle", "aria-label"), "切换到浅色模式");
        assert.equal(
          await page.attribute('meta[name="theme-color"]', "content"),
          "#171511"
        );

        await page.navigateFresh();
        await page.waitForReady();
        assert.equal(await page.attribute("html", "data-theme"), "dark");
        assert.equal(await page.attribute("#theme-toggle", "aria-label"), "切换到浅色模式");

        await page.click("#theme-toggle");
        await page.waitFor("document.documentElement.dataset.theme === 'light'");
        assert.equal(
          await page.evaluate("localStorage.getItem('marknotes.theme')"),
          "light"
        );
      });

      await t.test("移动端：列表/编辑切换、返回与新建", { timeout: 30000 }, async () => {
        await resetApp({ mobile: true });
        await page.waitForReady();
        await waitForNoteCount(5);

        const mobileList = await page.evaluate(`(() => {
          const sidebar = getComputedStyle(document.querySelector(".sidebar"));
          const workspace = getComputedStyle(document.querySelector(".workspace"));
          return {
            innerWidth,
            sidebarDisplay: sidebar.display,
            workspaceDisplay: workspace.display,
            scrollWidth: document.documentElement.scrollWidth
          };
        })()`);

        assert.equal(mobileList.innerWidth, 390);
        assert.equal(isVisible(mobileList.sidebarDisplay), true);
        assert.equal(mobileList.workspaceDisplay, "none");
        assert.ok(mobileList.scrollWidth <= 390, "移动端列表不应横向溢出");

        await page.click("#note-list .note-item");
        await page.waitFor("document.querySelector('#app').classList.contains('is-editor-open')");

        const mobileEditor = await page.evaluate(`(() => {
          const sidebar = getComputedStyle(document.querySelector(".sidebar"));
          const workspace = getComputedStyle(document.querySelector(".workspace"));
          const back = getComputedStyle(document.querySelector("#back-button"));
          const title = document.querySelector("#note-title").getBoundingClientRect();
          return {
            sidebarDisplay: sidebar.display,
            workspaceDisplay: workspace.display,
            backDisplay: back.display,
            titleLeft: title.left,
            titleRight: title.right,
            scrollWidth: document.documentElement.scrollWidth,
            activeTitle: document.querySelector("#note-title").value,
            backVisible: document.querySelector("#back-button").getBoundingClientRect().width > 0
          };
        })()`);

        assert.equal(mobileEditor.sidebarDisplay, "none");
        assert.equal(mobileEditor.workspaceDisplay, "flex");
        assert.equal(isVisible(mobileEditor.backDisplay), true);
        assert.equal(mobileEditor.backVisible, true);
        assert.ok(mobileEditor.titleLeft >= 0 && mobileEditor.titleRight <= 390);
        assert.ok(mobileEditor.scrollWidth <= 390, "移动端编辑器不应横向溢出");
        assert.equal(mobileEditor.activeTitle, "欢迎来到马克笔记");

        await page.click("#back-button");
        await page.waitFor("document.querySelector('#app').classList.contains('is-editor-open') === false");
        const afterBack = await page.evaluate(`({
          sidebarDisplay: getComputedStyle(document.querySelector(".sidebar")).display,
          workspaceDisplay: getComputedStyle(document.querySelector(".workspace")).display
        })`);
        assert.equal(isVisible(afterBack.sidebarDisplay), true);
        assert.equal(afterBack.workspaceDisplay, "none");

        await page.click("#new-note-button");
        await page.waitFor("document.querySelector('#app').classList.contains('is-editor-open')");
        await waitForNoteCount(6);
        assert.equal(await page.value("#note-title"), "");
        assert.equal(
          await page.evaluate("document.activeElement && document.activeElement.id === 'note-title'"),
          true
        );

        await page.click("#back-button");
        await page.waitFor("document.querySelector('#app').classList.contains('is-editor-open') === false");
        await page.setViewport(1440, 900, false);
      });

      await t.test("基础可访问性结构", { timeout: 20000 }, async () => {
        await resetApp();
        await waitForNoteCount(5);

        const report = await page.evaluate(`(() => {
          const ids = Array.from(document.querySelectorAll("[id]")).map((element) => element.id);
          const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
          const buttons = Array.from(document.querySelectorAll("button"));
          const unnamedButtons = buttons.filter((button) => {
            const ariaLabel = (button.getAttribute("aria-label") || "").trim();
            const text = (button.textContent || "").trim();
            const title = (button.getAttribute("title") || "").trim();
            return !ariaLabel && !text && !title;
          }).length;
          const controls = Array.from(document.querySelectorAll("input, textarea"));
          const unlabeledControls = controls.filter((control) => {
            const ariaLabel = (control.getAttribute("aria-label") || "").trim();
            const labelledBy = control.getAttribute("aria-labelledby");
            const labels = control.labels ? control.labels.length : 0;
            return !ariaLabel && !labelledBy && labels === 0;
          }).length;
          return {
            duplicateIds,
            unnamedButtons,
            unlabeledControls,
            hasMain: Boolean(document.querySelector("main")),
            hasNav: Boolean(document.querySelector("nav[aria-label]")),
            dialogLabelled: Boolean(
              document.querySelector("#delete-dialog[aria-labelledby][aria-describedby]")
            ),
            liveStatus: Boolean(document.querySelector("#save-status[role='status'][aria-live]")),
            buttonsWithoutType: buttons.filter((button) => !button.hasAttribute("type")).length
          };
        })()`);

        assert.deepEqual(report.duplicateIds, []);
        assert.equal(report.unnamedButtons, 0);
        assert.equal(report.unlabeledControls, 0);
        assert.equal(report.hasMain, true);
        assert.equal(report.hasNav, true);
        assert.equal(report.dialogLabelled, true);
        assert.equal(report.liveStatus, true);
        assert.equal(report.buttonsWithoutType, 0);
      });

      await t.test("生成桌面与移动端验收截图", { timeout: 30000 }, async () => {
        await resetApp();
        await waitForNoteCount(5);
        await delay(450);

        const desktopLight = path.join(SCREENSHOT_DIR, "desktop-light.png");
        await page.captureScreenshot(desktopLight);

        await page.click("#theme-toggle");
        await page.waitFor("document.documentElement.dataset.theme === 'dark'");
        await delay(350);
        const desktopDark = path.join(SCREENSHOT_DIR, "desktop-dark.png");
        await page.captureScreenshot(desktopDark);

        await page.setViewport(390, 844, true);
        await page.setColorScheme("light");
        await page.evaluate("localStorage.removeItem('marknotes.theme')");
        await page.navigateFresh({ settle: 20 });
        await waitForNoteCount(5);
        await delay(450);
        const mobileList = path.join(SCREENSHOT_DIR, "mobile-list.png");
        await page.captureScreenshot(mobileList);

        await page.click("#note-list .note-item");
        await page.waitFor("document.querySelector('#app').classList.contains('is-editor-open')");
        await delay(350);
        const mobileEditor = path.join(SCREENSHOT_DIR, "mobile-editor.png");
        await page.captureScreenshot(mobileEditor);

        for (const screenshot of [desktopLight, desktopDark, mobileList, mobileEditor]) {
          assert.ok(fs.existsSync(screenshot), "截图应存在：" + screenshot);
          assert.ok(fs.statSync(screenshot).size > 10000, "截图内容应完整：" + screenshot);
        }

        await page.setViewport(1440, 900, false);
      });

      await t.test("运行期间没有页面异常或控制台错误", async () => {
        assert.deepEqual(pageErrors, [], "页面不应产生未捕获异常\n" + pageErrors.join("\n"));
        assert.deepEqual(
          consoleErrors,
          [],
          "页面不应产生控制台错误\n" + consoleErrors.join("\n")
        );
      });
    } finally {
      if (harness) {
        await harness.close();
      }
      await closeServer(server);
    }
  }
);
