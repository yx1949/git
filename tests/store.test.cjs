"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NoteStore,
  STORAGE_KEY,
  SCHEMA_VERSION,
  MAX_TITLE_LENGTH,
  MAX_CONTENT_LENGTH
} = require("../store.js");

const BASE_TIME = Date.UTC(2026, 10, 23, 10, 0, 0);

function createMemoryStorage(initialValue) {
  const values = new Map();
  if (initialValue !== undefined) {
    values.set(STORAGE_KEY, initialValue);
  }

  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    dump(key = STORAGE_KEY) {
      return values.get(key);
    }
  };
}

function makeStore(options = {}) {
  return new NoteStore({
    storage: createMemoryStorage(),
    now: () => BASE_TIME,
    seed: false,
    ...options
  });
}

test("首次启动会生成示范笔记并写入本地存储", () => {
  const storage = createMemoryStorage();
  const store = new NoteStore({ storage, now: () => BASE_TIME });

  assert.equal(store.count(), 5);
  assert.equal(store.persistent, true);

  const list = store.list();
  assert.equal(list.length, 5);
  assert.equal(list[0].title, "欢迎来到马克笔记");
  assert.equal(list[0].pinned, true);

  const payload = JSON.parse(storage.dump());
  assert.equal(payload.version, SCHEMA_VERSION);
  assert.equal(payload.notes.length, 5);
  assert.ok(payload.notes.every((note) => typeof note.id === "string" && note.id.length > 0));
});

test("已保存的空笔记数组会被尊重，不会被示范数据覆盖", () => {
  const storage = createMemoryStorage(
    JSON.stringify({ version: SCHEMA_VERSION, notes: [] })
  );
  const store = new NoteStore({ storage, now: () => BASE_TIME });

  assert.equal(store.count(), 0);
  assert.deepEqual(store.list(), []);
});

test("读取已有笔记并按置顶、更新时间排序", () => {
  const notes = [
    {
      id: "ordinary-new",
      title: "普通笔记",
      content: "普通内容",
      pinned: false,
      createdAt: BASE_TIME - 2000,
      updatedAt: BASE_TIME
    },
    {
      id: "pinned-old",
      title: "置顶笔记",
      content: "置顶内容",
      pinned: true,
      createdAt: BASE_TIME - 4000,
      updatedAt: BASE_TIME - 4000
    },
    {
      id: "ordinary-old",
      title: "更早的笔记",
      content: "更早内容",
      pinned: false,
      createdAt: BASE_TIME - 5000,
      updatedAt: BASE_TIME - 5000
    }
  ];
  const storage = createMemoryStorage(
    JSON.stringify({ version: SCHEMA_VERSION, notes })
  );
  const store = new NoteStore({ storage, now: () => BASE_TIME });

  assert.deepEqual(
    store.list().map((note) => note.id),
    ["pinned-old", "ordinary-new", "ordinary-old"]
  );
});

test("新建笔记会持久化、生成唯一 ID，并返回防御性副本", () => {
  let now = BASE_TIME;
  const storage = createMemoryStorage();
  const store = new NoteStore({ storage, now: () => now, seed: false });

  const first = store.create({ title: "第一篇", content: "正文一" });
  now += 1000;
  const second = store.create({ title: "第二篇", content: "正文二" });

  assert.notEqual(first.id, second.id);
  assert.equal(store.count(), 2);
  assert.equal(store.list()[0].id, second.id);
  assert.equal(first.createdAt, BASE_TIME);
  assert.equal(first.updatedAt, BASE_TIME);

  first.title = "在外部篡改";
  first.content = "在外部篡改";
  assert.equal(store.get(first.id).title, "第一篇");

  const persisted = JSON.parse(storage.dump());
  assert.equal(persisted.notes.length, 2);
});

test("更新笔记会修改内容和更新时间，并保留整理顺序", () => {
  let now = BASE_TIME;
  const storage = createMemoryStorage();
  const store = new NoteStore({ storage, now: () => now, seed: false });
  const oldNote = store.create({ title: "旧笔记", content: "旧内容" });
  now += 1000;
  const newNote = store.create({ title: "新笔记", content: "新内容" });

  now += 5000;
  const updated = store.update(oldNote.id, {
    title: "更新后的标题",
    content: "更新后的内容"
  });

  assert.equal(updated.title, "更新后的标题");
  assert.equal(updated.content, "更新后的内容");
  assert.equal(updated.updatedAt, now);
  assert.equal(updated.createdAt, BASE_TIME);
  assert.deepEqual(
    store.list().map((note) => note.id),
    [oldNote.id, newNote.id]
  );

  const reloaded = new NoteStore({
    storage,
    now: () => now,
    seed: false
  });
  assert.equal(reloaded.get(oldNote.id).content, "更新后的内容");
});

test("没有实际变化时不刷新更新时间，也不写入存储", () => {
  let now = BASE_TIME;
  const storage = createMemoryStorage();
  const store = new NoteStore({ storage, now: () => now, seed: false });
  const note = store.create({ title: "标题", content: "内容" });

  let writes = 0;
  const originalSetItem = storage.setItem.bind(storage);
  storage.setItem = (...args) => {
    writes += 1;
    originalSetItem(...args);
  };

  now += 60000;
  const unchanged = store.update(note.id, { title: "标题", content: "内容" });

  assert.equal(unchanged.updatedAt, BASE_TIME);
  assert.equal(writes, 0);
});

test("置顶会改变排序但不修改编辑时间，并且可以取消置顶", () => {
  let now = BASE_TIME;
  const store = makeStore({ now: () => now });
  const first = store.create({ title: "第一篇", content: "一" });
  now += 1000;
  const second = store.create({ title: "第二篇", content: "二" });
  const originalUpdatedAt = second.updatedAt;

  const pinned = store.togglePin(first.id);

  assert.equal(pinned.pinned, true);
  assert.equal(pinned.updatedAt, originalUpdatedAt - 1000);
  assert.equal(store.list()[0].id, first.id);

  const unpinned = store.togglePin(first.id);
  assert.equal(unpinned.pinned, false);
  assert.equal(store.list()[0].id, second.id);
});

test("删除笔记返回正确结果并同步持久化", () => {
  const storage = createMemoryStorage();
  const store = new NoteStore({ storage, now: () => BASE_TIME, seed: false });
  const note = store.create({ title: "待删除", content: "" });

  assert.equal(store.remove(note.id), true);
  assert.equal(store.get(note.id), null);
  assert.equal(store.remove("missing-id"), false);
  assert.equal(JSON.parse(storage.dump()).notes.length, 0);
});

test("搜索同时匹配标题与正文，忽略大小写和前后空格", () => {
  const store = makeStore();
  store.create({ title: "Alpha 计划", content: "第一段" });
  store.create({ title: "其他", content: "这里包含 alpha 关键词" });
  store.create({ title: "杭州", content: "西湖散步" });

  assert.equal(store.list("ALPHA").length, 2);
  assert.equal(store.list("  西湖  ").length, 1);
  assert.equal(store.list("找不到的词").length, 0);
  assert.equal(store.list("   ").length, 3);
});

test("标题和正文会按字符数安全截断，支持 emoji", () => {
  const store = makeStore();
  const longTitle = "标".repeat(MAX_TITLE_LENGTH + 20);
  const longContent = "😀".repeat(MAX_CONTENT_LENGTH + 5);

  const note = store.create({ title: longTitle, content: longContent });

  assert.equal(Array.from(note.title).length, MAX_TITLE_LENGTH);
  assert.equal(Array.from(note.content).length, MAX_CONTENT_LENGTH);
  assert.equal(Array.from(note.content).at(-1), "😀");
});

test("损坏的 JSON 不会让应用崩溃，会回退到示范笔记", () => {
  const storage = createMemoryStorage("{ 这不是 JSON");
  const store = new NoteStore({ storage, now: () => BASE_TIME });

  assert.equal(store.count(), 5);
  assert.ok(store.loadError instanceof Error);
  assert.equal(store.list()[0].title, "欢迎来到马克笔记");
});

test("无效条目会被过滤，重复 ID 会重新生成", () => {
  let idCounter = 0;
  const notes = [
    null,
    "not-an-object",
    {
      id: "duplicate",
      title: "有效一",
      content: "内容",
      pinned: false,
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME
    },
    {
      id: "duplicate",
      title: "有效二",
      content: "内容",
      pinned: true,
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME
    }
  ];
  const storage = createMemoryStorage(
    JSON.stringify({ version: SCHEMA_VERSION, notes })
  );
  const store = new NoteStore({
    storage,
    now: () => BASE_TIME,
    idFactory: () => "generated-" + ++idCounter
  });

  const list = store.list();
  assert.equal(list.length, 2);
  assert.equal(new Set(list.map((note) => note.id)).size, 2);
  assert.ok(list.some((note) => note.id === "generated-1"));
});

test("存储写入失败时仍可在内存中使用，并标记为未持久化", () => {
  const storage = {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem() {}
  };
  const store = new NoteStore({ storage, now: () => BASE_TIME, seed: false });

  const note = store.create({ title: "内存笔记", content: "仍可编辑" });

  assert.equal(store.count(), 1);
  assert.equal(store.get(note.id).title, "内存笔记");
  assert.equal(store.persistent, false);
  assert.ok(store.storageError instanceof Error);
});

test("没有 storage 时使用安全的临时存储，不抛出异常", () => {
  const store = new NoteStore({ storage: null, now: () => BASE_TIME, seed: false });

  assert.equal(store.count(), 0);
  assert.equal(store.persistent, false);

  const note = store.create({ title: "临时笔记", content: "" });
  store.update(note.id, { content: "临时内容" });
  assert.equal(store.get(note.id).content, "临时内容");
});

test("缺少笔记、无效补丁等边界操作会安全返回", () => {
  const store = makeStore();
  const note = store.create({ title: "", content: "" });

  assert.equal(store.get("no-such-note"), null);
  assert.equal(store.update("no-such-note", { title: "不会成功" }), null);
  assert.equal(store.togglePin("no-such-note"), null);
  assert.equal(store.remove("no-such-note"), false);

  const invalid = store.update(note.id, { title: 123, content: null });
  assert.equal(invalid.title, "");
  assert.equal(invalid.content, "");
});

test("list 返回的数组和笔记对象不会反向修改内部数据", () => {
  const store = makeStore();
  const note = store.create({ title: "原始", content: "内容" });

  const list = store.list();
  list[0].title = "被修改";
  list.push({ id: "fake" });

  assert.equal(store.get(note.id).title, "原始");
  assert.equal(store.count(), 1);
});
