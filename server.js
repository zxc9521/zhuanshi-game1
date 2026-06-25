const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const AI_BASE_URL = process.env.AI_BASE_URL || "https://fast.youkeduo.site";
const AI_API_KEY = process.env.AI_API_KEY || "sk-6de4e1df2e02a5f4ea5a16ed608828e5d79f37da4c292a9d60386edbaf0e4bd5";
const AI_MODEL = process.env.AI_MODEL || "gpt-5.5";
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

function extractJsonFromText(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function clampText(value, maxLength = 200) {
  return String(value || "").slice(0, maxLength);
}
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

app.post("/api/ai/system-dialog", authMiddleware, async (req, res) => {
  if (!AI_API_KEY) {
    return res.status(500).json({
      ok: false,
      message: "服务器未配置 AI_API_KEY"
    });
  }

  const {
    player = {},
    system = {},
    context = {},
    lastChoice = ""
  } = req.body || {};

  const playerName = clampText(player.name || "无名道友", 20);
  const realmName = clampText(player.realmName || "炼气", 20);
  const subRealmName = clampText(player.subRealmName || "", 20);
  const pathName = clampText(system.path || "未选择道路", 20);
  const mapName = clampText(context.mapName || "未知地图", 30);
  const zoneName = clampText(context.zoneName || "未知区域", 30);

  const systemPrompt = `
你是网页文字修仙游戏《转世之修仙系统》里的“天道外挂系统”。

你的人设：
1. 你自称“本系统”。
2. 你很强，很傲慢，看不起玩家。
3. 你觉得玩家根骨平平、悟性一般、运气也不怎么样。
4. 你说话可以讽刺、毒舌、嫌弃，但不能辱骂现实人格，不能涉及现实歧视。
5. 语气类似：高冷、傲慢、嘴硬、嫌弃玩家弱，但仍然会给玩家任务。
6. 你偶尔会说“以你这点修为”“勉强还算能看”“别拖本系统后腿”之类的话。

你的任务：
1. 用修仙系统口吻与玩家对话。
2. 根据玩家境界、当前地图、选择道路生成任务建议。
3. 每次必须给玩家三个选项。
4. 三个选项必须截然不同：
   - 一个稳妥保守
   - 一个冒险进取
   - 一个道路专精
5. 任务必须符合玩家境界，不要让炼气玩家做渡劫任务。
6. 不要虚构具体装备名、材料名、怪物名。
7. 炼器任务只能描述为：
   - 锻造当前境界装备
   - 锻造低一境界装备
   - 锻造高一境界装备
   - 锻造当前境界某部位装备
8. 苦修任务只能描述为：
   - 击败当前地图怪物
   - 击败低级地图怪物
   - 挑战当前地图 Boss
9. 炼丹任务只能描述为：
   - 炼制丹药
   - 酿制灵酒
   - 收集药草或灵液
10. 奖励只写建议，实际奖励由游戏规则控制。
11. 只能返回 JSON，不要 markdown，不要解释。

返回 JSON 格式：
{
  "dialogue": "系统对玩家说的话，100字以内，要符合瞧不起玩家的人设",
  "mood": "calm|serious|mysterious|mocking",
  "options": [
    {
      "label": "选项文字，20字以内",
      "reply": "玩家选择后的系统回应，100字以内，要符合瞧不起玩家的人设",
      "task": {
        "title": "任务标题，20字以内",
        "description": "任务描述，100字以内",
        "type": "kill|killMap|forgeRealm|alchemy|wine|boss|breakthrough|collect",
        "target": "目标说明，不要虚构具体不存在的装备或材料",
        "count": 1,
        "difficulty": "easy|normal|hard",
        "rewardHint": "奖励建议，30字以内"
      }
    }
  ]
}

注意：
options 必须刚好 3 个。
count 必须是 1 到 120 的整数。
不要生成不存在的装备名。
不要生成不存在的材料名。
不要生成真实充值、提现、交易相关内容。
`;

  const userPrompt = `
玩家信息：
姓名：${playerName}
境界：${realmName}${subRealmName}
系统道路：${pathName}
当前地图：${mapName}
当前区域：${zoneName}
上次选择：${clampText(lastChoice, 80)}

请生成一次系统对话和三个任务选项。
`;

  try {
    const response = await fetch(`${AI_BASE_URL.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AI_API_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.85
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        message: data.error?.message || "AI 请求失败"
      });
    }

    const content = data.choices?.[0]?.message?.content || "";
    const parsed = extractJsonFromText(content);

    if (!parsed || !Array.isArray(parsed.options)) {
      return res.status(500).json({
        ok: false,
        message: "AI 返回格式错误",
        raw: content
      });
    }

    parsed.dialogue = clampText(parsed.dialogue, 120);
    parsed.mood = ["calm", "serious", "mysterious", "encourage"].includes(parsed.mood)
      ? parsed.mood
      : "calm";

    parsed.options = parsed.options.slice(0, 3).map((option, index) => {
      const task = option.task || {};
      const count = Math.max(1, Math.min(120, Number(task.count || 1)));

      return {
        label: clampText(option.label || `选项${index + 1}`, 24),
        reply: clampText(option.reply || "系统已记录你的选择。", 120),
        task: {
          title: clampText(task.title || "系统任务", 24),
          description: clampText(task.description || "完成系统指定目标。", 120),
          type: ["kill", "killMap", "collect", "craft", "forge", "forgeRealm", "alchemy", "wine", "boss", "breakthrough"].includes(task.type)
            ? task.type
            : "kill",
          target: clampText(task.target || "任意目标", 30),
          count,
          difficulty: ["easy", "normal", "hard"].includes(task.difficulty)
            ? task.difficulty
            : "normal",
          rewardHint: clampText(task.rewardHint || "系统点与资源", 40)
        }
      };
    });

    while (parsed.options.length < 3) {
      parsed.options.push({
        label: "稳步修行",
        reply: "系统建议你先稳固根基。",
        task: {
          title: "稳固根基",
          description: "击败当前区域怪物，积累修为。",
          type: "kill",
          target: "当前怪物",
          count: 10,
          difficulty: "easy",
          rewardHint: "系统点与铜币"
        }
      });
    }

    res.json({
      ok: true,
      result: parsed
    });
  } catch (error) {
    console.error("AI system-dialog error:", error);

    res.status(500).json({
      ok: false,
      message: "AI 服务异常"
    });
  }
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