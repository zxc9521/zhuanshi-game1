const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: "10mb" }));
app.use(express.static(PUBLIC_DIR));

function ensureFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ACCOUNTS_FILE)) fs.writeFileSync(ACCOUNTS_FILE, "{}");
  if (!fs.existsSync(PLAYERS_FILE)) fs.writeFileSync(PLAYERS_FILE, "{}");
}

function readJson(file) {
  ensureFiles();
  try {
    return JSON.parse(fs.readFileSync(file, "utf8") || "{}");
  } catch {
    return {};
  }
}

function writeJson(file, data) {
  ensureFiles();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const result = hashPassword(password, salt);
  return result.hash === hash;
}

function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

function sanitizeAccount(account) {
  return String(account || "").trim().toLowerCase();
}

function validateAccount(account) {
  return /^[a-zA-Z0-9_]{3,24}$/.test(account);
}

function validatePassword(password) {
  return typeof password === "string" && password.length >= 6 && password.length <= 64;
}

const sessions = new Map();

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ ok: false, message: "未登录或登录已过期" });
  }

  req.account = sessions.get(token).account;
  next();
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    name: "转世之修仙系统",
    publicWelfare: true,
    realRecharge: false,
    message: "服务器运行中。本游戏无真实充值入口，仙缘仅由游戏内玩法获得。"
  });
});

app.post("/api/register", (req, res) => {
  const account = sanitizeAccount(req.body.account);
  const password = req.body.password;
  const confirmPassword = req.body.confirmPassword;

  if (!validateAccount(account)) {
    return res.status(400).json({ ok: false, message: "账号只能使用字母、数字、下划线，长度 3-24 位" });
  }

  if (!validatePassword(password)) {
    return res.status(400).json({ ok: false, message: "密码长度需要 6-64 位" });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ ok: false, message: "两次密码不一致" });
  }

  const accounts = readJson(ACCOUNTS_FILE);

  if (accounts[account]) {
    return res.status(409).json({ ok: false, message: "账号已存在" });
  }

  const passwordData = hashPassword(password);

  accounts[account] = {
    account,
    salt: passwordData.salt,
    hash: passwordData.hash,
    createdAt: Date.now(),
    lastLoginAt: null,
    banned: false
  };

  writeJson(ACCOUNTS_FILE, accounts);

  res.json({ ok: true, message: "注册成功" });
});

app.post("/api/login", (req, res) => {
  const account = sanitizeAccount(req.body.account);
  const password = req.body.password;

  const accounts = readJson(ACCOUNTS_FILE);
  const user = accounts[account];

  if (!user) {
    return res.status(404).json({ ok: false, message: "账号不存在" });
  }

  if (user.banned) {
    return res.status(403).json({ ok: false, message: "账号已被封禁" });
  }

  if (!verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ ok: false, message: "密码错误" });
  }

  user.lastLoginAt = Date.now();
  writeJson(ACCOUNTS_FILE, accounts);

  const token = createToken();
  sessions.set(token, {
    account,
    createdAt: Date.now()
  });

  const players = readJson(PLAYERS_FILE);
  const playerData = players[account] || null;

  res.json({
    ok: true,
    message: "登录成功",
    token,
    account,
    playerData
  });
});

app.post("/api/logout", authMiddleware, (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token) sessions.delete(token);
  res.json({ ok: true, message: "已退出登录" });
});

app.get("/api/player", authMiddleware, (req, res) => {
  const players = readJson(PLAYERS_FILE);

  res.json({
    ok: true,
    account: req.account,
    playerData: players[req.account] || null
  });
});

app.post("/api/player/save", authMiddleware, (req, res) => {
  const playerData = req.body.playerData;

  if (!playerData || typeof playerData !== "object") {
    return res.status(400).json({ ok: false, message: "存档数据格式错误" });
  }

  const players = readJson(PLAYERS_FILE);

  players[req.account] = {
    ...playerData,
    serverSavedAt: Date.now()
  };

  writeJson(PLAYERS_FILE, players);

  res.json({
    ok: true,
    message: "存档成功",
    savedAt: players[req.account].serverSavedAt
  });
});

app.post("/api/player/create", authMiddleware, (req, res) => {
  const { name, gender } = req.body;

  if (!["男", "女"].includes(gender)) {
    return res.status(400).json({ ok: false, message: "请选择性别" });
  }

  if (!name || String(name).trim().length < 2 || String(name).trim().length > 8) {
    return res.status(400).json({ ok: false, message: "角色名需要 2-8 个字" });
  }

  const players = readJson(PLAYERS_FILE);

  if (players[req.account]?.player?.created) {
    return res.status(400).json({ ok: false, message: "角色已创建" });
  }

  players[req.account] = {
    version: 1,
    player: {
      name: String(name).trim(),
      gender,
      created: true
    },
    createdAt: Date.now(),
    serverSavedAt: Date.now()
  };

  writeJson(PLAYERS_FILE, players);

  res.json({
    ok: true,
    message: "角色创建成功",
    playerData: players[req.account]
  });
});

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({
    type: "system",
    message: "已连接《转世之修仙系统》WebSocket。聊天、公告、排行榜后续接入。"
  }));

  ws.on("message", (raw) => {
    let data = null;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "消息格式错误" }));
      return;
    }

    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", time: Date.now() }));
      return;
    }

    ws.send(JSON.stringify({
      type: "system",
      message: "当前 WebSocket 仅预留，聊天和系统公告后续开放。"
    }));
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

ensureFiles();

server.listen(PORT, () => {
  console.log(`《转世之修仙系统》服务器已启动：http://0.0.0.0:${PORT}`);
  console.log("公益服声明：无真实充值入口，仙缘不可交易、提现或现实货币兑换。");
});