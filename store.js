/* =========================================================
   马克笔记 · 数据层
   轻量、无依赖，可在浏览器与 Node.js 中运行。
   ========================================================= */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MarkNotesStore = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var STORAGE_KEY = "marknotes.notes.v1";
  var SCHEMA_VERSION = 1;
  var MAX_TITLE_LENGTH = 100;
  var MAX_CONTENT_LENGTH = 100000;

  var MINUTE = 60 * 1000;
  var HOUR = 60 * MINUTE;
  var DAY = 24 * HOUR;

  function generateId() {
    if (
      typeof globalThis.crypto !== "undefined" &&
      globalThis.crypto &&
      typeof globalThis.crypto.randomUUID === "function"
    ) {
      return globalThis.crypto.randomUUID();
    }

    return (
      "note-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 10)
    );
  }

  function limitText(value, maxLength) {
    if (typeof value !== "string") {
      return "";
    }

    // Array.from keeps surrogate pairs intact when enforcing the limit.
    var characters = Array.from(value);
    if (characters.length <= maxLength) {
      return value;
    }
    return characters.slice(0, maxLength).join("");
  }

  function safeTimestamp(value, fallback) {
    var timestamp = typeof value === "number" ? value : Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
  }

  function copyNote(note) {
    return {
      id: note.id,
      title: note.title,
      content: note.content,
      pinned: note.pinned,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt
    };
  }

  function normalizeStoredNotes(rawNotes, now, idFactory) {
    var normalized = [];
    var seenIds = Object.create(null);

    for (var index = 0; index < rawNotes.length; index += 1) {
      var raw = rawNotes[index];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }

      var createdAt = safeTimestamp(raw.createdAt, now);
      var updatedAt = safeTimestamp(raw.updatedAt, createdAt);
      var title = limitText(typeof raw.title === "string" ? raw.title : "", MAX_TITLE_LENGTH);
      var content = limitText(
        typeof raw.content === "string" ? raw.content : "",
        MAX_CONTENT_LENGTH
      );
      var id =
        typeof raw.id === "string" && raw.id.trim()
          ? raw.id.trim().slice(0, 120)
          : "";

      if (!id || seenIds[id]) {
        id = idFactory();
        while (seenIds[id]) {
          id = idFactory();
        }
      }
      seenIds[id] = true;

      normalized.push({
        id: id,
        title: title,
        content: content,
        pinned: raw.pinned === true,
        createdAt: createdAt,
        updatedAt: updatedAt
      });
    }

    return normalized;
  }

  function createSeedNotes(now) {
    var currentTime = Number.isFinite(now) && now > 0 ? now : Date.now();

    return [
      {
        id: "seed-welcome",
        title: "欢迎来到马克笔记",
        content:
          "这里是一页安静的数字纸张。\n\n在左侧挑选笔记，在右侧写下想法。每一次停顿，文字都会自动保存到这台设备上。\n\n几个小提示：\n· 点击右上角的图钉，可以把重要的想法置顶\n· Alt + N 新建笔记，Ctrl / ⌘ + K 随时搜索\n· Ctrl / ⌘ + S 立即保存，不必担心丢失\n\n现在，删掉这段文字，写下属于你的第一行吧。",
        pinned: true,
        createdAt: currentTime - 6 * DAY,
        updatedAt: currentTime - 18 * MINUTE
      },
      {
        id: "seed-reading",
        title: "周末书单：允许自己慢下来",
        content:
          "最近想读的三本书：\n\n1. 《山茶文具店》—— 在代笔人的字里行间，重新理解「认真」。\n2. 《日日是好日》—— 雨天听雨，雪天赏雪，夏天感受暑热。\n3. 《瓦尔登湖》—— 一个人越是有许多事情能够放下，他越是富有。\n\n读完后，记得把喜欢的句子抄回来。",
        pinned: false,
        createdAt: currentTime - 3 * DAY,
        updatedAt: currentTime - 4 * HOUR
      },
      {
        id: "seed-product",
        title: "一些关于产品的碎片灵感",
        content:
          "好的工具应该像一张干净的纸：安静、可靠，不抢走思考。\n\n· 默认少一点，需要时再多一点\n· 输入时不想保存，离开时它已经保存好了\n· 允许空白存在，空白也是内容的一部分\n\n下次试试用一句话解释这个功能。如果说不清，就再想想。",
        pinned: false,
        createdAt: currentTime - 2 * DAY,
        updatedAt: currentTime - 22 * HOUR
      },
      {
        id: "seed-hangzhou",
        title: "杭州 · 两日散步路线",
        content:
          "Day 1\n· 清晨：北山街 — 断桥 — 白堤，趁人少先走一段湖岸\n· 午后：孤山 — 西泠印社 — 楼外楼\n· 傍晚：苏堤看日落，再慢慢走回南山路\n\nDay 2\n· 上午：法喜寺 — 梅灵北路，沿路有很多茶园\n· 下午：龙井村喝茶，把手机收进包里\n· 晚上：南山路书店，挑一本薄薄的小书\n\n备注：尽量坐公交或骑车，周末景区很难停车。",
        pinned: false,
        createdAt: currentTime - 12 * DAY,
        updatedAt: currentTime - 2 * DAY
      },
      {
        id: "seed-writing",
        title: "摘录：关于写作",
        content:
          "写作不是把想清楚的东西记录下来，而是借由写作把东西想清楚。\n\n先写下去，再写好。\n初稿不需要完美，它只需要存在。",
        pinned: false,
        createdAt: currentTime - 30 * DAY,
        updatedAt: currentTime - 8 * DAY
      }
    ];
  }

  function detectStorage() {
    try {
      var storage = globalThis.localStorage;
      if (!storage) {
        return null;
      }
      var probe = "__marknotes_storage_probe__";
      storage.setItem(probe, "1");
      storage.removeItem(probe);
      return storage;
    } catch (error) {
      return null;
    }
  }

  function NoteStore(options) {
    options = options || {};

    this.storage =
      Object.prototype.hasOwnProperty.call(options, "storage")
        ? options.storage
        : detectStorage();
    this.storageKey = options.storageKey || STORAGE_KEY;
    this.now =
      typeof options.now === "function" ? options.now : function () { return Date.now(); };
    this.idFactory =
      typeof options.idFactory === "function" ? options.idFactory : generateId;
    this._notes = [];
    this._persistent = Boolean(this.storage);
    this.storageError = null;
    this.loadError = null;

    this._load(options.seed !== false);
  }

  NoteStore.prototype._clock = function () {
    var value = Number(this.now());
    return Number.isFinite(value) && value > 0 ? value : Date.now();
  };

  NoteStore.prototype._load = function (seedEnabled) {
    var raw = null;
    var hasStoredValue = false;

    if (this.storage) {
      try {
        raw = this.storage.getItem(this.storageKey);
        hasStoredValue = raw !== null && raw !== undefined;
      } catch (error) {
        this.storageError = error;
        this._persistent = false;
      }
    }

    if (hasStoredValue) {
      try {
        var parsed = JSON.parse(raw);
        var rawNotes =
          parsed && !Array.isArray(parsed) && Array.isArray(parsed.notes)
            ? parsed.notes
            : Array.isArray(parsed)
              ? parsed
              : null;

        if (!rawNotes) {
          throw new Error("笔记数据格式不正确");
        }

        this._notes = normalizeStoredNotes(rawNotes, this._clock(), this.idFactory);

        if (rawNotes.length > 0 && this._notes.length === 0) {
          throw new Error("没有可读取的笔记");
        }
        return;
      } catch (error) {
        this.loadError = error;
        this.storageError = error;
        this._notes = seedEnabled ? createSeedNotes(this._clock()) : [];
        return;
      }
    }

    if (seedEnabled) {
      this._notes = createSeedNotes(this._clock());
      this._persist();
    }
  };

  NoteStore.prototype._persist = function () {
    if (!this.storage) {
      this._persistent = false;
      this.storageError = new Error("当前环境不支持本地存储");
      return false;
    }

    try {
      this.storage.setItem(
        this.storageKey,
        JSON.stringify({
          version: SCHEMA_VERSION,
          notes: this._notes
        })
      );
      this._persistent = true;
      this.storageError = null;
      return true;
    } catch (error) {
      this._persistent = false;
      this.storageError = error;
      return false;
    }
  };

  NoteStore.prototype._find = function (id) {
    for (var index = 0; index < this._notes.length; index += 1) {
      if (this._notes[index].id === id) {
        return this._notes[index];
      }
    }
    return null;
  };

  Object.defineProperty(NoteStore.prototype, "persistent", {
    get: function () {
      return this._persistent;
    }
  });

  NoteStore.prototype.list = function (query) {
    var term = "";
    if (typeof query === "string") {
      term = query;
    } else if (query && typeof query.query === "string") {
      term = query.query;
    }
    term = term.trim().toLocaleLowerCase();

    var notes = this._notes
      .filter(function (note) {
        if (!term) {
          return true;
        }
        return (
          note.title.toLocaleLowerCase().indexOf(term) !== -1 ||
          note.content.toLocaleLowerCase().indexOf(term) !== -1
        );
      })
      .slice()
      .sort(function (a, b) {
        if (a.pinned !== b.pinned) {
          return a.pinned ? -1 : 1;
        }
        if (a.updatedAt !== b.updatedAt) {
          return b.updatedAt - a.updatedAt;
        }
        return a.id.localeCompare(b.id);
      });

    return notes.map(copyNote);
  };

  NoteStore.prototype.get = function (id) {
    var note = this._find(id);
    return note ? copyNote(note) : null;
  };

  NoteStore.prototype.count = function () {
    return this._notes.length;
  };

  NoteStore.prototype.create = function (attributes) {
    attributes = attributes || {};
    var timestamp = this._clock();
    var note = {
      id: this._newId(),
      title: limitText(attributes.title, MAX_TITLE_LENGTH),
      content: limitText(attributes.content, MAX_CONTENT_LENGTH),
      pinned: false,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this._notes.unshift(note);
    this._persist();
    return copyNote(note);
  };

  NoteStore.prototype._newId = function () {
    var id = String(this.idFactory());
    while (!id || this._find(id)) {
      id = String(this.idFactory());
    }
    return id;
  };

  NoteStore.prototype.update = function (id, patch) {
    var note = this._find(id);
    if (!note) {
      return null;
    }
    if (!patch || typeof patch !== "object") {
      return copyNote(note);
    }

    var changed = false;

    if (Object.prototype.hasOwnProperty.call(patch, "title")) {
      var nextTitle = limitText(patch.title, MAX_TITLE_LENGTH);
      if (nextTitle !== note.title) {
        note.title = nextTitle;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, "content")) {
      var nextContent = limitText(patch.content, MAX_CONTENT_LENGTH);
      if (nextContent !== note.content) {
        note.content = nextContent;
        changed = true;
      }
    }

    if (changed) {
      note.updatedAt = this._clock();
      this._persist();
    }

    return copyNote(note);
  };

  NoteStore.prototype.togglePin = function (id) {
    var note = this._find(id);
    if (!note) {
      return null;
    }

    note.pinned = !note.pinned;
    this._persist();
    return copyNote(note);
  };

  NoteStore.prototype.remove = function (id) {
    var index = -1;
    for (var cursor = 0; cursor < this._notes.length; cursor += 1) {
      if (this._notes[cursor].id === id) {
        index = cursor;
        break;
      }
    }

    if (index === -1) {
      return false;
    }

    this._notes.splice(index, 1);
    this._persist();
    return true;
  };

  return Object.freeze({
    NoteStore: NoteStore,
    STORAGE_KEY: STORAGE_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_TITLE_LENGTH: MAX_TITLE_LENGTH,
    MAX_CONTENT_LENGTH: MAX_CONTENT_LENGTH,
    createSeedNotes: createSeedNotes
  });
});
