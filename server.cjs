"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function sendText(response, statusCode, message) {
  const body = Buffer.from(message, "utf8");
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function createStaticServer(rootDirectory) {
  const root = path.resolve(rootDirectory || path.join(__dirname));

  return http.createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendText(response, 405, "Method Not Allowed");
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch (error) {
      sendText(response, 400, "Bad Request");
      return;
    }

    if (pathname === "/") {
      pathname = "/index.html";
    }

    const relativePath = pathname.replace(/^[/\\]+/, "");
    const filePath = path.resolve(root, relativePath);

    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      sendText(response, 403, "Forbidden");
      return;
    }

    fs.stat(filePath, (statError, stat) => {
      if (statError || !stat.isFile()) {
        sendText(response, 404, "Not Found");
        return;
      }

      const extension = path.extname(filePath).toLowerCase();
      const headers = {
        "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
        "Content-Length": stat.size,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "X-Content-Type-Options": "nosniff"
      };

      response.writeHead(200, headers);
      if (request.method === "HEAD") {
        response.end();
        return;
      }

      const stream = fs.createReadStream(filePath);
      stream.on("error", () => {
        if (!response.headersSent) {
          sendText(response, 500, "Internal Server Error");
        } else {
          response.destroy();
        }
      });
      stream.pipe(response);
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4173;
  const host = process.env.HOST || "127.0.0.1";
  const server = createStaticServer(path.join(__dirname));

  server.listen(port, host, () => {
    console.log("马克笔记已启动：http://" + host + ":" + port);
    console.log("按 Ctrl + C 停止服务。");
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error("端口 " + port + " 已被占用，请用 PORT 环境变量指定其他端口。");
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { createStaticServer };
