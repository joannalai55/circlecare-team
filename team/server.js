#!/usr/bin/env node
// CircleCare Team Dashboard — local dispatch server
// 純 Node 內建模組，不需要 npm install。啟動：node server.js（或 ./start.sh）
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const crypto = require("crypto");

const TEAM_DIR = __dirname; // .../CircleCare/team
const PROJECT_DIR = path.resolve(TEAM_DIR, ".."); // .../CircleCare  (claude 從這裡找 .claude/agents)
const RUNTIME_DIR = path.join(PROJECT_DIR, ".runtime");
fs.mkdirSync(RUNTIME_DIR, { recursive: true });
const DATA_FILE = path.join(RUNTIME_DIR, "team.json");
if (!fs.existsSync(DATA_FILE)) fs.copyFileSync(path.join(TEAM_DIR, "dashboard-data.example.json"), DATA_FILE);
const ENABLE_DISPATCH = process.env.ENABLE_DISPATCH === "1";
const RUNS_FILE = path.join(RUNTIME_DIR, "dispatch-runs.json");
const PORT = process.env.PORT ? Number(process.env.PORT) : 4317;
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

// ---------------- dashboard-data.js (source of truth) ----------------
function readTeamData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function writeTeamData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// 簡單的寫入佇列，避免兩個派工幾乎同時結束時互相覆蓋對方的寫入
let writeChain = Promise.resolve();
function withDataLock(fn) {
  writeChain = writeChain.then(fn).catch((e) => console.error("[dataLock]", e));
  return writeChain;
}

// ---------------- runs store ----------------
function loadRuns() {
  try {
    return JSON.parse(fs.readFileSync(RUNS_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveRuns(list) {
  fs.mkdirSync(path.dirname(RUNS_FILE), { recursive: true });
  fs.writeFileSync(RUNS_FILE, JSON.stringify(list.slice(-50), null, 2), "utf8");
}
let runs = loadRuns();
for (const run of runs) {
  if (run.status === "running") { run.status = "blocked"; run.isError = true; run.result = "Server restarted; previous process status is unknown."; }
}

function buildCommand(data, memberIds, task, roundtable) {
  if (roundtable) return "Use the maggie, ryan, evan, vivi, and amy subagents to discuss this task and synthesize their perspectives: " + task;
  const names = data.members
    .filter((m) => memberIds.includes(m.id))
    .map((m) => m.id)
    .join(", ");
  return "Use these project subagents: " + names + ". Task: " + task;
}

function dispatch(memberIds, task, roundtable) {
  const data = readTeamData();
  const command = buildCommand(data, memberIds, task, roundtable);
  const id = crypto.randomBytes(4).toString("hex");
  const startedAt = new Date().toISOString();

  data.members.forEach((m) => {
    if (memberIds.includes(m.id)) {
      m.status = "working";
      m.currentTask = task;
    }
  });
  writeTeamData(data);

  const run = {
    id,
    who: memberIds,
    roundtable: !!roundtable,
    task,
    command,
    status: "running",
    startedAt,
    finishedAt: null,
    result: null,
    cost: null,
    isError: false,
  };
  runs.push(run);
  saveRuns(runs);

  const child = spawn(
    CLAUDE_BIN,
    ["-p", command, "--permission-mode", "acceptEdits", "--output-format", "json"],
    { cwd: PROJECT_DIR, env: process.env }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.on("error", (err) => {
    run.status = "blocked";
    run.isError = true;
    run.result = `無法啟動 claude CLI：${err.message}`;
    run.finishedAt = new Date().toISOString();
    saveRuns(runs);
  });
  child.on("close", (code) => {
    run.finishedAt = new Date().toISOString();
    let parsed = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      /* not JSON, fall through */
    }
    if (parsed) {
      run.result = parsed.result || "(無文字回覆)";
      run.cost = typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null;
      run.isError = !!parsed.is_error;
    } else {
      run.result = (stderr || stdout || `程序結束，exit code ${code}`).trim();
      run.isError = code !== 0;
    }
    run.status = run.isError ? "blocked" : "done";
    saveRuns(runs);

    withDataLock(() => {
      const d2 = readTeamData();
      d2.members.forEach((m) => {
        if (memberIds.includes(m.id) && m.status === "working" && m.currentTask === task) {
          m.status = run.isError ? "blocked" : "done";
          m.currentTask = null;
        }
      });
      const who = roundtable
        ? "圓桌會議"
        : d2.members
            .filter((m) => memberIds.includes(m.id))
            .map((m) => m.name)
            .join("、");
      const summary = (run.result || "").slice(0, 140).replace(/\s+/g, " ");
      d2.recentActivity = d2.recentActivity || [];
      d2.recentActivity.unshift({
        date: todayStr(),
        who,
        what: (run.isError ? "⚠️ 執行失敗：" : "") + (summary || "完成任務"),
      });
      d2.recentActivity = d2.recentActivity.slice(0, 30);
      d2.lastUpdated = todayStr();
      writeTeamData(d2);
    });
  });

  return run;
}

// ---------------- HTTP ----------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function sendJson(res, status, body) {
  const b = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(b),
  });
  res.end(b);
}

const server = http.createServer((req, res) => {
  let u;
  try {
    u = new URL(req.url, "http://localhost");
  } catch {
    return sendJson(res, 400, { error: "bad url" });
  }
  const p = u.pathname;
  const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  if (!allowedHosts.has(req.headers.host)) return sendJson(res, 403, { error: "Invalid host" });
  const origin = req.headers.origin;
  if (origin && ![...allowedHosts].some(h => origin === `http://${h}`)) {
    return sendJson(res, 403, { error: "Cross-origin requests are not allowed" });
  }

  if (req.method === "GET" && p === "/api/state") {
    try {
      return sendJson(res, 200, readTeamData());
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  if (req.method === "GET" && p === "/api/runs") {
    return sendJson(res, 200, runs.slice(-30).reverse());
  }

  if (req.method === "POST" && p === "/api/dispatch") {
    if (!ENABLE_DISPATCH) return sendJson(res, 403, { error: "Preview mode. Start with ENABLE_DISPATCH=1 to enable Claude Code tasks." });
    if (!(req.headers["content-type"] || "").startsWith("application/json")) return sendJson(res, 415, { error: "Expected application/json" });
    let body = "";
    let tooLarge = false;
    req.on("data", (c) => {
      if (tooLarge) return;
      body += c;
      if (Buffer.byteLength(body) > 65536) { tooLarge = true; sendJson(res, 413, { error: "Task is too large" }); }
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        const payload = JSON.parse(body || "{}");
        const memberIds = Array.isArray(payload.memberIds) ? payload.memberIds : [];
        const task = String(payload.task || "").trim();
        const roundtable = !!payload.roundtable;
        if (!task || (!roundtable && memberIds.length === 0)) {
          return sendJson(res, 400, { error: "請選擇成員並輸入任務內容" });
        }
        const known = new Set(readTeamData().members.map(m => m.id));
        if (memberIds.some(id => !known.has(id))) return sendJson(res, 400, { error: "Unknown agent" });
        if (runs.some(r => r.status === "running")) return sendJson(res, 409, { error: "Wait for the current task to finish" });
        const run = dispatch(roundtable ? [...known] : memberIds, task, roundtable);
        return sendJson(res, 200, { ok: true, runId: run.id });
      } catch (e) {
        return sendJson(res, 400, { error: String(e.message || e) });
      }
    });
    return;
  }

  if (req.method !== "GET" || !["/", "/dashboard.html"].includes(p)) {
    return sendJson(res, 404, { error: "not found" });
  }
  fs.readFile(path.join(TEAM_DIR, "dashboard.html"), (err, content) => {
    if (err) return sendJson(res, 500, { error: "Dashboard unavailable" });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  });
});

if (ENABLE_DISPATCH) execFile(CLAUDE_BIN, ["--version"], (err) => {
  if (err) {
    console.error(
      `⚠️  找不到 claude CLI（指令："${CLAUDE_BIN}"）。派工功能會失敗。可設定環境變數 CLAUDE_BIN 指向完整路徑，例如 CLAUDE_BIN=/opt/homebrew/bin/claude node server.js`
    );
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`🐾 CircleCare Team Dashboard server 啟動：http://localhost:${PORT}`);
});
