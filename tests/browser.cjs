"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const BROWSER_CANDIDATES = [
  process.env.EDGE_PATH,
  process.env.CHROME_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
].filter(Boolean);

function findBrowserExecutable() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch (error) {
      // Keep looking.
    }
  }
  return null;
}

async function waitForFile(filePath, timeout) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    try {
      await fsp.access(filePath);
      return;
    } catch (error) {
      await delay(40);
    }
  }
  throw new Error("等待浏览器调试端口文件超时：" + filePath);
}

async function fetchJson(url, timeout = 2000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    throw new Error("HTTP " + response.status + " · " + url);
  }
  return response.json();
}

async function waitForTargets(port, timeout) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeout) {
    try {
      const targets = await fetchJson("http://127.0.0.1:" + port + "/json/list");
      if (Array.isArray(targets) && targets.length > 0) {
        return targets;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(60);
  }

  throw new Error(
    "浏览器已启动，但无法读取调试目标。" + (lastError ? " " + lastError.message : "")
  );
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;

    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        entry.reject(new Error("CDP 连接已关闭"));
      }
      this.pending.clear();
    });
    socket.addEventListener("error", () => {
      // Individual commands will reject if the socket can no longer respond.
    });
  }

  static async connect(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("连接页面调试通道超时"));
      }, 10000);

      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );

      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("无法连接浏览器页面调试通道"));
        },
        { once: true }
      );
    });

    return new CdpClient(socket);
  }

  handleMessage(event) {
    let message;
    try {
      const raw =
        typeof event.data === "string"
          ? event.data
          : Buffer.from(event.data).toString("utf8");
      message = JSON.parse(raw);
    } catch (error) {
      return;
    }

    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(
          new Error(
            "CDP " +
              pending.method +
              " 失败：" +
              message.error.message +
              (message.error.data ? " " + message.error.data : "")
          )
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      const callbacks = this.listeners.get(message.method);
      if (callbacks) {
        callbacks.forEach((callback) => {
          try {
            callback(message.params || {});
          } catch (error) {
            // User callbacks must not break the protocol dispatcher.
          }
        });
      }
    }
  }

  on(method, callback) {
    if (!this.listeners.has(method)) {
      this.listeners.set(method, new Set());
    }
    this.listeners.get(method).add(callback);
    return () => {
      const callbacks = this.listeners.get(method);
      if (callbacks) {
        callbacks.delete(callback);
      }
    };
  }

  send(method, params = {}, timeout = 15000) {
    if (this.closed) {
      return Promise.reject(new Error("CDP 连接已关闭"));
    }

    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP 命令超时：" + method));
      }, timeout);

      this.pending.set(id, {
        resolve,
        reject,
        timeout: timer,
        method
      });

      try {
        this.socket.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    try {
      this.socket.close();
    } catch (error) {
      // Already closed.
    }
  }
}

class TestPage {
  constructor(client, baseUrl) {
    this.client = client;
    this.baseUrl = baseUrl;
    this.navigationSequence = 0;
  }

  async evaluate(expression) {
    const result = await this.client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });

    if (result.exceptionDetails) {
      const exception = result.exceptionDetails;
      const description =
        (exception.exception && exception.exception.description) ||
        exception.text ||
        "页面脚本执行失败";
      throw new Error(description);
    }

    return result.result ? result.result.value : undefined;
  }

  async waitFor(expression, options = {}) {
    const timeout = options.timeout || 8000;
    const interval = options.interval || 50;
    const startedAt = Date.now();
    let lastError = null;

    while (Date.now() - startedAt < timeout) {
      try {
        const value = await this.evaluate(expression);
        if (value) {
          return value;
        }
      } catch (error) {
        lastError = error;
      }
      await delay(interval);
    }

    throw new Error(
      "等待页面状态超时：" +
        (options.message || expression.slice(0, 180)) +
        (lastError ? "（" + lastError.message + "）" : "")
    );
  }

  async waitForReady(timeout = 12000) {
    await this.waitFor(
      "document.readyState === 'complete' && document.documentElement.dataset.appReady === 'true'",
      { timeout, message: "应用初始化完成" }
    );
  }

  async navigateFresh(options = {}) {
    this.navigationSequence += 1;
    const token = "e2e-" + Date.now() + "-" + this.navigationSequence;
    const url = new URL(this.baseUrl);
    url.searchParams.set("e2e", token);

    const result = await this.client.send("Page.navigate", { url: url.toString() });
    if (result.errorText) {
      throw new Error("页面导航失败：" + result.errorText);
    }

    await this.waitFor(
      "document.readyState !== 'loading' && document.documentElement.dataset.appReady === 'true' && new URL(location.href).searchParams.get('e2e') === " +
        JSON.stringify(token),
      { timeout: 12000, message: "页面重新加载完成" }
    );

    if (options.settle) {
      await delay(options.settle);
    }
  }

  async setViewport(width, height, mobile = false) {
    await this.client.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
      screenWidth: width,
      screenHeight: height,
      positionX: 0,
      positionY: 0,
      dontSetVisibleSize: false
    });
    await this.client.send("Emulation.setTouchEmulationEnabled", {
      enabled: Boolean(mobile),
      maxTouchPoints: mobile ? 5 : 1
    });
  }

  async setColorScheme(scheme) {
    await this.client.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }]
    });
  }

  async click(selector) {
    const result = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) {
        return { ok: false, reason: "not-found" };
      }
      if (element.disabled) {
        return { ok: false, reason: "disabled" };
      }
      element.click();
      return { ok: true };
    })()`);

    if (!result || !result.ok) {
      throw new Error("无法点击元素 " + selector + (result ? "：" + result.reason : ""));
    }
  }

  async focus(selector) {
    const result = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) {
        return false;
      }
      element.focus({ preventScroll: false });
      return document.activeElement === element;
    })()`);

    if (!result) {
      throw new Error("无法聚焦元素 " + selector);
    }
  }

  async typeText(text) {
    await this.client.send("Input.insertText", { text });
  }

  async typeInto(selector, text, options = {}) {
    await this.focus(selector);
    if (options.replace) {
      await this.evaluate(`(() => {
        const element = document.activeElement;
        if (element && typeof element.select === "function") {
          element.select();
        }
        return true;
      })()`);
    }
    await this.typeText(text);
  }

  async pressKey(key, options = {}) {
    const modifiers = options.modifiers || 0;
    const code = options.code || key;
    const windowsVirtualKeyCode = options.virtualKeyCode || 0;
    const event = {
      modifiers,
      key,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode
    };

    await this.client.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...event
    });
    await this.client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      ...event
    });
  }

  async pressControlShortcut(letter) {
    const upper = letter.toUpperCase();
    const keyCodes = {
      K: 75,
      N: 78,
      S: 83
    };
    await this.pressKey(letter.toLowerCase(), {
      modifiers: 2,
      code: "Key" + upper,
      virtualKeyCode: keyCodes[upper] || upper.charCodeAt(0)
    });
  }

  async pressAltShortcut(letter) {
    const upper = letter.toUpperCase();
    await this.pressKey(letter.toLowerCase(), {
      modifiers: 1,
      code: "Key" + upper,
      virtualKeyCode: upper.charCodeAt(0)
    });
  }

  async text(selector) {
    return this.evaluate(
      `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        return element ? element.textContent : null;
      })()`
    );
  }

  async value(selector) {
    return this.evaluate(
      `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        return element ? element.value : null;
      })()`
    );
  }

  async attribute(selector, name) {
    return this.evaluate(
      `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        return element ? element.getAttribute(${JSON.stringify(name)}) : null;
      })()`
    );
  }

  async count(selector) {
    return this.evaluate(
      `document.querySelectorAll(${JSON.stringify(selector)}).length`
    );
  }

  async captureScreenshot(filePath) {
    const result = await this.client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false
    });
    await fsp.writeFile(filePath, Buffer.from(result.data, "base64"));
  }
}

async function readTail(filePath, maxBytes = 6000) {
  try {
    const content = await fsp.readFile(filePath, "utf8");
    return content.slice(-maxBytes);
  } catch (error) {
    return "";
  }
}

async function removeProfileDirectory(profileDirectory) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fsp.rm(profileDirectory, { recursive: true, force: true, maxRetries: 2 });
      return;
    } catch (error) {
      await delay(200);
    }
  }
}

async function waitForExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeout);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function launchBrowser(baseUrl) {
  const executable = findBrowserExecutable();
  if (!executable) {
    throw new Error(
      "没有找到 Microsoft Edge 或 Google Chrome。请通过 EDGE_PATH 环境变量指定浏览器可执行文件。"
    );
  }

  const profileDirectory = await fsp.mkdtemp(
    path.join(os.tmpdir(), "marknotes-e2e-profile-")
  );
  const stderrPath = path.join(profileDirectory, "browser-stderr.log");
  const stderrFd = fs.openSync(stderrPath, "a");

  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--metrics-recording-only",
    "--mute-audio",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profileDirectory,
    "--window-size=1440,900",
    "--force-device-scale-factor=1",
    baseUrl
  ];

  const child = spawn(executable, args, {
    stdio: ["ignore", "ignore", stderrFd],
    windowsHide: true
  });
  fs.closeSync(stderrFd);

  let client = null;

  const cleanup = async () => {
    if (client) {
      client.close();
      client = null;
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child, 4000);
    }
    await removeProfileDirectory(profileDirectory);
  };

  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    const portFile = path.join(profileDirectory, "DevToolsActivePort");
    await Promise.race([
      waitForFile(portFile, 15000),
      exitPromise.then(({ code, signal }) => {
        throw new Error(
          "浏览器在启动时退出（code=" +
            code +
            ", signal=" +
            signal +
            "）。\n" +
            "日志：\n" +
            "等待日志写入"
        );
      })
    ]);

    const portContents = await fsp.readFile(portFile, "utf8");
    const port = Number(portContents.split(/\r?\n/)[0]);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error("浏览器返回了无效的调试端口");
    }

    const targets = await waitForTargets(port, 12000);
    const pageTarget =
      targets.find(
        (target) =>
          target.type === "page" &&
          target.webSocketDebuggerUrl &&
          typeof target.url === "string" &&
          (target.url.startsWith("http") || target.url.startsWith("file:"))
      ) || targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);

    if (!pageTarget) {
      throw new Error("没有找到可调试的浏览器页面");
    }

    client = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");

    const page = new TestPage(client, baseUrl);
    const browserVersion = await client.send("Browser.getVersion");

    return {
      executable,
      page,
      client,
      browserVersion,
      async close() {
        if (client) {
          try {
            await Promise.race([
              client.send("Browser.close", {}, 2500),
              delay(1200)
            ]);
          } catch (error) {
            // The browser often closes the socket before replying.
          }
          client.close();
          client = null;
        }
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await waitForExit(child, 5000);
        await removeProfileDirectory(profileDirectory);
      }
    };
  } catch (error) {
    const logTail = await readTail(stderrPath);
    await cleanup();
    if (logTail) {
      error.message += "\n浏览器日志（末尾）：\n" + logTail;
    }
    throw error;
  }
}

module.exports = {
  delay,
  findBrowserExecutable,
  launchBrowser
};
