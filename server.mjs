import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, unlink, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scrypt = promisify(scryptCallback);
const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(process.env.DOCS_DRIVE_DATA_DIR || join(ROOT, ".docs-drive-data"));
const UPLOAD_DIR = join(DATA_DIR, "uploads");
const DB_PATH = join(DATA_DIR, "docs-drive.sqlite");
const INDEX_PATH = join(ROOT, "index.html");
const APP_PATH = join(ROOT, "app.js");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const ACCOUNT_LIMIT = 1024 * 1024 * 1024;
const FILE_LIMIT = 100 * 1024 * 1024;
const SESSION_COOKIE = "docs_drive_session";
const SHORT_SESSION_MS = 12 * 60 * 60 * 1000;
const LONG_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_MIN = 12;
const MAX_JSON_BYTES = 16 * 1024;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const SAFE_PREVIEW_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

await mkdir(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
db.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);");
db.exec("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);");
db.exec("CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);");
db.exec("CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, mime_type TEXT NOT NULL, category TEXT NOT NULL, size INTEGER NOT NULL CHECK(size > 0), created_at INTEGER NOT NULL, starred INTEGER NOT NULL DEFAULT 0 CHECK(starred IN (0,1)));");
db.exec("CREATE INDEX IF NOT EXISTS files_user_created_idx ON files(user_id, created_at DESC);");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (res, status, data, extraHeaders = {}) => {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  res.end(body);
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const secureCookie = process.env.NODE_ENV === "production" ? "; Secure" : "";
const setCookie = (res, token, maxAge) => {
  res.setHeader("Set-Cookie", SESSION_COOKIE + "=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + maxAge + secureCookie);
};
const clearCookie = (res) => {
  res.setHeader("Set-Cookie", SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" + secureCookie);
};

const getCookie = (req, key) => {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === key) return part.slice(separator + 1).trim();
  }
  return "";
};

const assertSameOrigin = (req) => {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    if (new URL(origin).host !== req.headers.host) throw new HttpError(403, "Request origin was rejected.");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(403, "Request origin was rejected.");
  }
};

const readJson = async (req) => {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) throw new HttpError(415, "Send JSON for this request.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, "Request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
};

const attempts = new Map();
const clientKey = (req) => {
  const forwarded = process.env.TRUST_PROXY === "true" ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
  return forwarded || req.socket.remoteAddress || "unknown";
};
const checkRateLimit = (req) => {
  const key = clientKey(req);
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.until <= now) {
    attempts.set(key, { count: 1, until: now + ATTEMPT_WINDOW_MS });
    return;
  }
  if (current.count >= MAX_ATTEMPTS) throw new HttpError(429, "Too many attempts. Wait 15 minutes and try again.");
  current.count += 1;
};

const scryptOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const hashPassword = async (password, salt) => {
  const key = await scrypt(password, salt, 64, scryptOptions);
  return key.toString("base64url");
};
const verifyPassword = async (password, salt, expected) => {
  const actual = Buffer.from(await hashPassword(password, salt), "base64url");
  const wanted = Buffer.from(expected, "base64url");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
};

const createSession = (userId, res, remember) => {
  const duration = remember ? LONG_SESSION_MS : SHORT_SESSION_MS;
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES(?, ?, ?, ?)").run(sha256(token), userId, Date.now() + duration, Date.now());
  setCookie(res, token, Math.floor(duration / 1000));
};

const currentUser = (req) => {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token || token.length > 128) return null;
  const row = db.prepare("SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?").get(sha256(token), Date.now());
  return row || null;
};

const requireUser = (req) => {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, "Please sign in again.");
  return user;
};

const validateUsername = (value) => {
  if (typeof value !== "string") throw new HttpError(400, "Enter a username.");
  const username = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/.test(username)) {
    throw new HttpError(400, "Use 3–32 characters: letters, numbers, dots, hyphens, or underscores.");
  }
  return { username, key: username.toLowerCase() };
};

const validatePassword = (value, forRegistration = false) => {
  if (typeof value !== "string" || value.length === 0) throw new HttpError(400, "Enter your password.");
  if (forRegistration && value.length < PASSWORD_MIN) throw new HttpError(400, "Choose a password with at least 12 characters.");
  if (value.length > 128) throw new HttpError(400, "Password must be 128 characters or fewer.");
  return value;
};

const categoryFor = (mime, name) => {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|rtf|csv|odt)$/i.test(name)) return "document";
  return "other";
};

const publicFile = (row) => ({
  id: row.id,
  name: row.name,
  mimeType: row.mime_type,
  category: row.category,
  size: Number(row.size),
  createdAt: Number(row.created_at),
  starred: row.starred === 1
});

const userLocks = new Map();
const withUserLock = async (userId, action) => {
  const previous = userLocks.get(userId) || Promise.resolve();
  let release;
  const next = new Promise((resolvePromise) => { release = resolvePromise; });
  const chain = previous.then(() => next);
  userLocks.set(userId, chain);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (userLocks.get(userId) === chain) userLocks.delete(userId);
  }
};

const uploadFile = async (req, user) => withUserLock(user.id, async () => {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (declaredLength >= FILE_LIMIT) throw new HttpError(413, "Each file must be smaller than 100 MB.");
  const current = db.prepare("SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE user_id = ?").get(user.id);
  const used = Number(current.used || 0);
  if (declaredLength && used + declaredLength > ACCOUNT_LIMIT) throw new HttpError(413, "This account does not have enough room. The limit is 1 GB.");

  let suppliedName = String(req.headers["x-file-name"] || "file");
  try { suppliedName = decodeURIComponent(suppliedName); } catch { throw new HttpError(400, "File name is not valid."); }
  const name = suppliedName.replace(/\\/g, "/").split("/").pop().replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 240) || "file";
  const rawMime = String(req.headers["content-type"] || "application/octet-stream").split(";")[0].trim().toLowerCase();
  const mime = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(rawMime) ? rawMime : "application/octet-stream";
  const id = randomUUID();
  const userDirectory = join(UPLOAD_DIR, user.id);
  await mkdir(userDirectory, { recursive: true });
  const temporaryPath = join(userDirectory, id + ".part");
  const finalPath = join(userDirectory, id + ".bin");
  const handle = await open(temporaryPath, "wx", 0o600);
  let size = 0;
  let rejectedFor = "";
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (!rejectedFor && size >= FILE_LIMIT) rejectedFor = "Each file must be smaller than 100 MB.";
      if (!rejectedFor && used + size > ACCOUNT_LIMIT) rejectedFor = "This account does not have enough room. The limit is 1 GB.";
      if (!rejectedFor) await handle.write(chunk);
    }
    await handle.close();
    if (rejectedFor) throw new HttpError(413, rejectedFor);
    if (size === 0) throw new HttpError(400, "Empty files cannot be uploaded.");
    await rename(temporaryPath, finalPath);
    db.prepare("INSERT INTO files(id, user_id, name, mime_type, category, size, created_at, starred) VALUES(?, ?, ?, ?, ?, ?, ?, 0)")
      .run(id, user.id, name, mime, categoryFor(mime, name), size, Date.now());
    return { id, name, size, category: categoryFor(mime, name) };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    await unlink(finalPath).catch(() => {});
    throw error;
  }
});

const fileForUser = (id, user) => {
  const row = db.prepare("SELECT id, user_id, name, mime_type, category, size, created_at, starred FROM files WHERE id = ? AND user_id = ?").get(id, user.id);
  if (!row) throw new HttpError(404, "File was not found.");
  return row;
};

const streamFile = async (res, row, disposition) => {
  const filePath = join(UPLOAD_DIR, row.user_id, row.id + ".bin");
  let fileStat;
  try { fileStat = await stat(filePath); } catch { throw new HttpError(404, "Stored file was not found."); }
  const preview = disposition === "inline";
  const mime = preview && SAFE_PREVIEW_TYPES.has(row.mime_type) ? row.mime_type : "application/octet-stream";
  const headers = {
    "Content-Type": mime,
    "Content-Length": fileStat.size,
    "Content-Disposition": preview ? "inline" : "attachment; filename=\"download\"; filename*=UTF-8''" + encodeURIComponent(row.name).replace(/'/g, "%27"),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff"
  };
  res.writeHead(200, headers);
  const stream = createReadStream(filePath);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
};

const sendPage = (req, res) => {
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  };
  const stream = createReadStream(INDEX_PATH);
  stream.on("error", () => {
    if (!res.headersSent) json(res, 500, { error: "Website page could not be opened." });
    else res.destroy();
  });
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  stream.pipe(res);
};

const sendAppScript = (req, res) => {
  const stream = createReadStream(APP_PATH);
  stream.on("error", () => {
    if (!res.headersSent) json(res, 500, { error: "Website app could not be opened." });
    else res.destroy();
  });
  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff"
  });
  if (req.method === "HEAD") return res.end();
  stream.pipe(res);
};

const handle = async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  const url = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));
  const path = url.pathname;

  // Lightweight health check for Docker and hosting-platform probes.
  if ((req.method === "GET" || req.method === "HEAD") && path === "/health") {
    return json(res, 200, { ok: true, service: "docs-drive" });
  }

  if ((req.method === "GET" || req.method === "HEAD") && (path === "/" || path === "/index.html")) return sendPage(req, res);
  if ((req.method === "GET" || req.method === "HEAD") && path === "/app.js") return sendAppScript(req, res);

  if (path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
    if (path === "/api/auth/register" && req.method === "POST") {
      assertSameOrigin(req);
      checkRateLimit(req);
      const body = await readJson(req);
      const { username, key } = validateUsername(body.username);
      const password = validatePassword(body.password, true);
      const salt = randomBytes(16).toString("hex");
      const passwordHash = await hashPassword(password, salt);
      const id = randomUUID();
      try {
        db.prepare("INSERT INTO users(id, username, username_key, salt, password_hash, created_at) VALUES(?, ?, ?, ?, ?, ?)")
          .run(id, username, key, salt, passwordHash, Date.now());
      } catch (error) {
        if (String(error.message || "").includes("UNIQUE")) throw new HttpError(409, "That username is already in use.");
        throw error;
      }
      createSession(id, res, body.remember === true);
      attempts.delete(clientKey(req));
      return json(res, 201, { user: { id, username } });
    }

    if (path === "/api/auth/login" && req.method === "POST") {
      assertSameOrigin(req);
      checkRateLimit(req);
      const body = await readJson(req);
      const { username, key } = validateUsername(body.username);
      const password = validatePassword(body.password, false);
      const user = db.prepare("SELECT id, username, salt, password_hash FROM users WHERE username_key = ?").get(key);
      const valid = user ? await verifyPassword(password, user.salt, user.password_hash) : await hashPassword(password, "docs-drive-dummy-salt-0123456789");
      if (!user || !valid) throw new HttpError(401, "Username or password is incorrect.");
      createSession(user.id, res, body.remember === true);
      attempts.delete(clientKey(req));
      return json(res, 200, { user: { id: user.id, username: user.username } });
    }

    if (path === "/api/auth/logout" && req.method === "POST") {
      assertSameOrigin(req);
      const token = getCookie(req, SESSION_COOKIE);
      if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
      clearCookie(res);
      return json(res, 200, { ok: true });
    }

    if (path === "/api/auth/me" && req.method === "GET") {
      const user = currentUser(req);
      return json(res, 200, { user: user ? { id: user.id, username: user.username } : null });
    }

    if (path === "/api/files" && req.method === "GET") {
      const user = requireUser(req);
      const rows = db.prepare("SELECT id, user_id, name, mime_type, category, size, created_at, starred FROM files WHERE user_id = ? ORDER BY created_at DESC").all(user.id);
      return json(res, 200, { files: rows.map(publicFile), accountLimit: ACCOUNT_LIMIT, fileLimit: FILE_LIMIT });
    }

    if (path === "/api/files" && req.method === "POST") {
      assertSameOrigin(req);
      const user = requireUser(req);
      const saved = await uploadFile(req, user);
      return json(res, 201, saved);
    }

    const downloadMatch = path.match(/^\/api\/files\/([0-9a-f-]{36})\/(download|preview)$/i);
    if (downloadMatch && req.method === "GET") {
      const user = requireUser(req);
      const row = fileForUser(downloadMatch[1], user);
      if (downloadMatch[2] === "preview" && row.category !== "image") throw new HttpError(404, "Preview was not found.");
      if (downloadMatch[2] === "preview" && !SAFE_PREVIEW_TYPES.has(row.mime_type)) throw new HttpError(404, "Preview was not found.");
      return streamFile(res, row, downloadMatch[2] === "preview" ? "inline" : "attachment");
    }

    const fileMatch = path.match(/^\/api\/files\/([0-9a-f-]{36})$/i);
    if (fileMatch && req.method === "PATCH") {
      assertSameOrigin(req);
      const user = requireUser(req);
      const body = await readJson(req);
      if (typeof body.starred !== "boolean") throw new HttpError(400, "Choose whether the file is starred.");
      const result = db.prepare("UPDATE files SET starred = ? WHERE id = ? AND user_id = ?").run(body.starred ? 1 : 0, fileMatch[1], user.id);
      if (Number(result.changes) === 0) throw new HttpError(404, "File was not found.");
      return json(res, 200, { ok: true });
    }
    if (fileMatch && req.method === "DELETE") {
      assertSameOrigin(req);
      const user = requireUser(req);
      const row = fileForUser(fileMatch[1], user);
      db.prepare("DELETE FROM files WHERE id = ? AND user_id = ?").run(row.id, user.id);
      await unlink(join(UPLOAD_DIR, user.id, row.id + ".bin")).catch(() => {});
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, "API route was not found.");
  }

  throw new HttpError(404, "Page was not found.");
};

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (res.headersSent) return res.destroy();
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error("Docs Drive request failed:", error);
    json(res, status, { error: status >= 500 ? "The server could not complete that request." : error.message });
  });
});

server.requestTimeout = 5 * 60 * 1000;
server.headersTimeout = 65 * 1000;
server.keepAliveTimeout = 5 * 1000;
const cleanupTimer = setInterval(() => {
  try { db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now()); } catch (error) { console.error("Session cleanup failed:", error); }
}, 15 * 60 * 1000);
cleanupTimer.unref();

server.listen(PORT, HOST, () => {
  console.log("Docs Drive listening at http://" + HOST + ":" + PORT);
  console.log("Persistent data directory: " + DATA_DIR);
});

const shutdown = () => {
  clearInterval(cleanupTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
