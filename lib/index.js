/**
 * @dsh-session-delete-menu — Host half.
 *
 * Own implementation: no third-party plugin is involved. It stops the live
 * agent for the session, detaches the session store entry so every connected
 * client drops the row, then removes the on-disk session artifact, and exposes
 * the two endpoints the menu row calls:
 *
 *   GET  /session-delete/api/preview?sessionId=...        -> what will be touched
 *   POST /session-delete/api/delete  {sessionId|sessionIds} -> perform the removal
 *   POST /session-delete/api/archive {sessionIds, archived} -> batch archive toggle
 *
 * Every request is admitted through DSH's own `connection` service and must
 * resolve to an owner peer, so the endpoints are not open to unrelated local
 * processes.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "dsh-session-delete-menu";

/** Services this plugin needs; `connection` and `webServer` gate the endpoints. */
export const inject = ["webServer", "connection", "sessions", "agents", "workspaceRegistry"];

const API_PREFIX = "/session-delete/api";
const SESSION_ID_PATTERN = /^session-[0-9A-Za-z_-]{4,160}$/;
const DETACH_SETTLE_MS = 200;
const DISPOSE_BUDGET_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolve the DSH home directory, preferring an explicit config override. */
function resolveDshHome(config) {
  if (config && typeof config.dshHome === "string" && config.dshHome.trim() !== "") {
    return config.dshHome.trim();
  }
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return join(homedir(), ".dsh");
}

/** Reject anything that is not a plain session id, so no path segment is user-shaped. */
function assertSessionId(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    const error = new Error("sessionId 不合法");
    error.code = "bad-request";
    throw error;
  }
  return sessionId;
}

/**
 * Find every on-disk directory holding this session. Layout is
 * `<dshHome>/sessions/<workspace-bucket>/<sessionId>`, and a session can appear
 * in more than one bucket when it was moved between workspaces.
 */
async function findSessionDirs(sessionsRoot, sessionId) {
  const found = [];
  let buckets;
  try {
    buckets = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const candidate = join(sessionsRoot, bucket.name, sessionId);
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) found.push(candidate);
    } catch {
      /* not in this bucket */
    }
  }
  return found;
}

function errorMessage(error) {
  if (error === null || error === undefined) return "未知错误";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message !== "") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Stop the live agent for this session so nothing rewrites the artifact mid-delete. */
async function stopAgent(ctx, sessionId) {
  let wasLive = false;
  let agent;
  try {
    agent = ctx.agents?.get?.(sessionId);
  } catch {
    agent = undefined;
  }
  if (agent === undefined || agent === null) return wasLive;
  wasLive = true;
  try {
    agent.cancel?.({ kind: "disposed" });
  } catch {
    /* cancellation is best-effort; disposal below is the real stop */
  }
  try {
    if (typeof agent.scope?.dispose === "function") {
      await Promise.race([agent.scope.dispose(), sleep(DISPOSE_BUDGET_MS)]);
    }
  } catch {
    /* bounded dispose: a stalled teardown must not block the delete */
  }
  try {
    ctx.agents?.store?.delete?.(sessionId);
  } catch {
    /* registry cleanup is best-effort */
  }
  return wasLive;
}

/**
 * Detach the session store entry. `detach` makes the persistence layer drain
 * and lets the API proxy relay `session/disposed`, which is what removes the
 * row from every connected client. Sessions with no live store row never fire
 * it, so the event is emitted explicitly in that case.
 */
async function detachSession(ctx, sessionId) {
  const session = ctx.sessions?.get?.(sessionId);
  if (session !== undefined && session !== null) {
    try {
      await ctx.sessions?.flush?.(session);
    } catch {
      /* flushing is an optimisation; detach still drains */
    }
  }
  let detached = false;
  try {
    const entry = ctx.sessions?.store?.get?.(sessionId);
    if (entry !== undefined && entry !== null && typeof entry.detach === "function") {
      entry.detach();
      await sleep(DETACH_SETTLE_MS);
      detached = true;
    }
  } catch {
    /* fall through to the explicit event */
  }
  if (!detached) {
    try {
      ctx.emit("session/disposed", { id: sessionId });
    } catch {
      /* a client that misses the frame refreshes on the next list load */
    }
  }
}

/** Remove the session and report exactly what happened. */
async function deleteSession(ctx, dshHome, sessionId) {
  assertSessionId(sessionId);
  const sessionsRoot = join(dshHome, "sessions");
  const dirs = await findSessionDirs(sessionsRoot, sessionId);
  const wasLive = await stopAgent(ctx, sessionId);
  await detachSession(ctx, sessionId);

  const removedDirs = [];
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
    removedDirs.push(dir);
  }

  return {
    sessionId,
    filesRemoved: removedDirs.length > 0,
    removedDirs,
    wasLive
  };
}

/** Summarise the blast radius for the confirmation dialog. */
async function previewSession(ctx, dshHome, sessionId) {
  assertSessionId(sessionId);
  const dirs = await findSessionDirs(join(dshHome, "sessions"), sessionId);
  let live = false;
  try {
    live = Boolean(ctx.sessions?.get?.(sessionId) || ctx.agents?.get?.(sessionId));
  } catch {
    live = false;
  }
  return {
    sessionId,
    artifactCount: dirs.length,
    hasArtifact: dirs.length > 0,
    live
  };
}

/** Archive or unarchive one session through the host workspace registry. */
async function setArchived(ctx, sessionId, archived) {
  assertSessionId(sessionId);
  const registry = ctx.workspaceRegistry;
  if (registry === undefined || registry === null) {
    const error = new Error("工作区服务未就绪，无法归档");
    error.code = "unavailable";
    throw error;
  }
  if (archived) {
    const alreadyListed = typeof registry.archivedSessionIds?.includes === "function"
      && registry.archivedSessionIds.includes(sessionId);
    if (!alreadyListed) await registry.archiveSession(sessionId);
  } else {
    await registry.unarchiveSession(sessionId);
  }
  return { sessionId, archived };
}

/** Run one operation over every id, collecting per-session failures instead of aborting. */
async function forEachSession(sessionIds, run) {
  const succeeded = [];
  const failed = [];
  for (const sessionId of sessionIds) {
    try {
      await run(sessionId);
      succeeded.push(sessionId);
    } catch (error) {
      failed.push({ sessionId, error: errorMessage(error) });
    }
  }
  return { succeeded, failed };
}

/**
 * Admit the request through DSH's own connection service. Owner principals only:
 * deleting a conversation is a privileged, irreversible operation.
 */
function authenticate(ctx, req) {
  let connection;
  try {
    connection = ctx.connection ?? ctx.get?.("connection");
  } catch {
    connection = undefined;
  }
  if (connection === undefined || connection === null || typeof connection.admit !== "function") {
    return { ok: false, status: 503, error: "DSH 认证服务未就绪，已拒绝请求" };
  }
  try {
    const admission = connection.admit(req);
    if (admission === undefined || admission === null || typeof admission !== "object") {
      return { ok: false, status: 401, error: "未授权：需要有效的 DSH 会话凭证" };
    }
    if ("rejection" in admission) {
      const status = typeof admission.rejection === "number" ? admission.rejection : 401;
      return { ok: false, status, error: status === 403 ? "禁止访问：未通过 DSH 信任检查" : "未授权：需要有效的 DSH 会话凭证" };
    }
    const principalKind = admission.peer?.principal?.kind;
    if (principalKind !== "owner") {
      return { ok: false, status: 403, error: "禁止访问：删除会话需要 owner 权限" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, status: 403, error: "认证检查失败：" + errorMessage(error) };
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

/** Parse a JSON object body, answering 400 itself when the payload is unusable. */
async function readJsonBody(req, res) {
  const raw = await readBody(req);
  if (raw.trim() === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    sendJson(res, 400, { ok: false, error: "请求体必须是 JSON 对象" });
    return undefined;
  }
  return parsed;
}

/** Accept either `sessionIds: [...]` (multi-select) or a single `sessionId`. */
function sessionIdsOf(body) {
  if (Array.isArray(body.sessionIds)) {
    const unique = new Set();
    for (const value of body.sessionIds) {
      if (typeof value === "string" && value.trim() !== "") unique.add(value.trim());
    }
    return [...unique];
  }
  if (typeof body.sessionId === "string" && body.sessionId.trim() !== "") return [body.sessionId.trim()];
  return [];
}

export function apply(ctx, config) {
  const settings = config && typeof config === "object" ? config : {};
  const dshHome = resolveDshHome(settings);

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      const auth = authenticate(ctx, req);
      if (!auth.ok) {
        sendJson(res, auth.status, { ok: false, code: "unauthorized", error: auth.error });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || "/" : "/";

      try {
        if (req.method === "GET" && path === "/preview") {
          const sessionId = url.searchParams.get("sessionId") ?? "";
          const result = await previewSession(ctx, dshHome, sessionId);
          sendJson(res, 200, { ok: true, result });
          return;
        }
        if (req.method === "POST" && path === "/delete") {
          const body = await readJsonBody(req, res);
          if (body === undefined) return;
          const sessionIds = sessionIdsOf(body);
          if (sessionIds.length === 0) {
            sendJson(res, 400, { ok: false, error: "sessionIds 不能为空" });
            return;
          }
          if (sessionIds.length === 1) {
            const result = await deleteSession(ctx, dshHome, sessionIds[0]);
            sendJson(res, 200, { ok: true, result });
            return;
          }
          const batch = await forEachSession(sessionIds, (id) => deleteSession(ctx, dshHome, id));
          sendJson(res, 200, {
            ok: true,
            result: {
              requested: sessionIds.length,
              deleted: batch.succeeded.length,
              succeeded: batch.succeeded,
              failed: batch.failed
            }
          });
          return;
        }
        if (req.method === "POST" && path === "/archive") {
          const body = await readJsonBody(req, res);
          if (body === undefined) return;
          const sessionIds = sessionIdsOf(body);
          if (sessionIds.length === 0) {
            sendJson(res, 400, { ok: false, error: "sessionIds 不能为空" });
            return;
          }
          const archived = body.archived !== false;
          const batch = await forEachSession(sessionIds, (id) => setArchived(ctx, id, archived));
          sendJson(res, 200, {
            ok: true,
            result: {
              archived,
              requested: sessionIds.length,
              succeeded: batch.succeeded,
              failed: batch.failed
            }
          });
          return;
        }
        sendJson(res, 404, { ok: false, error: "未知接口：" + req.method + " " + path });
      } catch (error) {
        const code = error && error.code === "bad-request" ? 400 : 500;
        sendJson(res, code, { ok: false, error: errorMessage(error) });
      }
    }
  }));
}
