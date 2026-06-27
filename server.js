"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const CHAT_FILE = path.join(DATA_DIR, "world_chat.json");
const TRADES_FILE = path.join(DATA_DIR, "trades.json");

const AI_BASE_URL = process.env.AI_BASE_URL || "https://fast.youkeduo.site";
const AI_API_KEY = process.env.AI_API_KEY || "sk-6de4e1df2e02a5f4ea5a16ed608828e5d79f37da4c292a9d60386edbaf0e4bd5";
const AI_MODEL = process.env.AI_MODEL || "gpt-5.5";

const onlineClients = new Map();
const worldChatMessages = [];
const WORLD_CHAT_LIMIT = 80;
const TRADE_FEE_RATE = 0.05;
const TRADE_PAGE_SIZE = 10;
const GM_ACCOUNTS = String(process.env.GM_ACCOUNTS || "zxc9521a")
  .split(",")
  .map(item => item.trim())
  .filter(Boolean);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJsonSync(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const txt = fs.readFileSync(file, "utf8");
    if (!txt.trim()) return fallback;
    return JSON.parse(txt);
  } catch (error) {
    console.error(`读取 ${file} 失败：`, error);
    return fallback;
  }
}

async function writeJson(file, data) {
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

function uid(prefix = "id") {
  return (
    prefix +
    "_" +
    crypto.randomBytes(8).toString("hex") +
    "_" +
    Date.now().toString(36)
  );
}

function createToken() {
  return crypto.randomBytes(24).toString("hex");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto
    .pbkdf2Sync(String(password), salt, 100000, 64, "sha512")
    .toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const check = crypto
    .pbkdf2Sync(String(password), salt, 100000, 64, "sha512")
    .toString("hex");
  return crypto.timingSafeEqual(Buffer.from(check), Buffer.from(hash));
}

function sanitizeText(text, maxLength = 80) {
  return String(text || "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeLongText(text, maxLength = 1200) {
  return String(text || "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function extractJsonFromText(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function loadPlayers() {
  return readJsonSync(PLAYERS_FILE, {});
}

function loadSessions() {
  return readJsonSync(SESSIONS_FILE, {});
}

function loadWorldChat() {
  const saved = readJsonSync(CHAT_FILE, []);
  if (Array.isArray(saved)) {
    worldChatMessages.splice(0, worldChatMessages.length, ...saved.slice(-WORLD_CHAT_LIMIT));
  }
}

function savePlayers(players) {
  return writeJson(PLAYERS_FILE, players);
}

function saveSessions(sessions) {
  return writeJson(SESSIONS_FILE, sessions);
}

function saveWorldChat() {
  return writeJson(CHAT_FILE, worldChatMessages.slice(-WORLD_CHAT_LIMIT));
}

let players = loadPlayers();
let sessions = loadSessions();
let trades = readJsonSync(TRADES_FILE, []);
loadWorldChat();

function saveTrades() {
  return writeJson(TRADES_FILE, trades);
}

function cloneData(data) {
  return JSON.parse(JSON.stringify(data));
}

function getPlayerData(account) {
  return players[account]?.playerData || null;
}

function ensurePlayerData(account) {
  const record = ensurePlayerRecord(account);
  if (!record.playerData) {
    record.playerData = {};
  }
  if (!record.playerData.resources) {
    record.playerData.resources = { coin: 0, yuanbao: 0, xianyuan: 0, systemPoint: 0 };
  }
  if (!Array.isArray(record.playerData.bag)) {
    record.playerData.bag = [];
  }
  if (!Array.isArray(record.playerData.store)) {
    record.playerData.store = [];
  }
  return record.playerData;
}

function isTradableEquip(item) {
  return item &&
    item.id &&
    item.craftedBy &&
    item.identified === false &&
    item.slot &&
    item.attrs;
}

function isTradablePill(item) {
  return item &&
    item.id &&
    item.type === "丹药" &&
    item.craftedBy;
}

function isTradableItem(item, source) {
  if (source === "store") return isTradableEquip(item);
  if (source === "bag") return isTradablePill(item);
  return false;
}

function getTradeItemKind(item, source) {
  if (source === "store") return "equip";
  if (source === "bag") return "pill";
  return "item";
}

function removeTradeItemFromPlayer(playerData, source, itemId) {
  if (source === "store") {
    const index = playerData.store.findIndex(item => item.id === itemId);
    if (index < 0) return null;
    const item = playerData.store[index];
    playerData.store.splice(index, 1);
    return item;
  }

  if (source === "bag") {
    const index = playerData.bag.findIndex(item => item.id === itemId);
    if (index < 0) return null;
    const item = playerData.bag[index];

    if ((item.count || 1) > 1) {
      item.count -= 1;
      const one = cloneData(item);
      one.id = uid("trade_item");
      one.count = 1;
      return one;
    }

    playerData.bag.splice(index, 1);
    return item;
  }

  return null;
}

function addTradeItemToPlayer(playerData, listing) {
  const item = cloneData(listing.item);

  if (listing.itemKind === "equip") {
    playerData.store.push(item);
    return;
  }

  if (listing.itemKind === "pill") {
    playerData.bag.push(item);
    return;
  }

  playerData.bag.push(item);
}

function ensurePlayerMails(playerData) {
  if (!Array.isArray(playerData.mails)) {
    playerData.mails = [];
  }
  return playerData.mails;
}

function sendServerMailToPlayer(account, title, body, attachment = null, source = "trade", from = "交易行") {
  const playerData = ensurePlayerData(account);
  const mails = ensurePlayerMails(playerData);

  mails.unshift({
    id: uid("mail"),
    title,
    body,
    from,
    created: Date.now(),
    expire: Date.now() + 1000 * 86400 * 30,
    read: false,
    claimed: !attachment,
    type: source,
    source,
    attachment: attachment || null
  });

  mails.splice(100);

  if (players[account]) {
    players[account].updatedAt = Date.now();
  }
}
function compactListing(listing) {
  return {
    id: listing.id,
    seller: listing.seller,
    sellerName: listing.sellerName,
    type: listing.type,
    itemKind: listing.itemKind,
    item: listing.item,
    price: listing.price,
    basePrice: listing.basePrice,
    bidStep: listing.bidStep,
    highestBid: listing.highestBid,
    highestBidder: listing.highestBidder,
    highestBidderName: listing.highestBidderName,
    startAt: listing.startAt,
    endAt: listing.endAt,
    status: listing.status
  };
}

async function settleExpiredTrades() {
  let changed = false;
  const time = Date.now();

  for (const listing of trades) {
    if (listing.status !== "active") continue;
    if (listing.type !== "auction") continue;
    if (!listing.endAt || listing.endAt > time) continue;

    if (listing.highestBidder && listing.highestBid > 0) {
      const sellerData = ensurePlayerData(listing.seller);
      const buyerData = ensurePlayerData(listing.highestBidder);

      const fee = Math.floor(listing.highestBid * TRADE_FEE_RATE);
      const sellerGain = Math.max(0, listing.highestBid - fee);

      sellerData.resources.yuanbao = (sellerData.resources.yuanbao || 0) + sellerGain;
      addTradeItemToPlayer(buyerData, listing);

      sendServerMailToPlayer(
        listing.seller,
        "竞拍成交通知",
        `你上架的【${listing.item?.name || "物品"}】竞拍成交，成交价 ${listing.highestBid} 元宝，手续费 ${fee} 元宝，实际到账 ${sellerGain} 元宝。`,
        null,
        "trade_auction_sold"
      );

      sendServerMailToPlayer(
        listing.highestBidder,
        "竞拍成功通知",
        `你成功拍下【${listing.item?.name || "物品"}】，成交价 ${listing.highestBid} 元宝。物品已直接进入你的背包或储物戒。`,
        null,
        "trade_auction_win"
      );

      players[listing.seller].updatedAt = Date.now();
      players[listing.highestBidder].updatedAt = Date.now();

      listing.status = "sold";
      listing.soldAt = Date.now();
      listing.buyer = listing.highestBidder;
      listing.buyerName = listing.highestBidderName;
      listing.fee = fee;
      listing.sellerGain = sellerGain;
    } else {
      const sellerData = ensurePlayerData(listing.seller);
      addTradeItemToPlayer(sellerData, listing);

      sendServerMailToPlayer(
        listing.seller,
        "竞拍流拍通知",
        `你上架的【${listing.item?.name || "物品"}】竞拍结束，但无人出价。物品已退回你的背包或储物戒。`,
        null,
        "trade_auction_expired"
      );

      players[listing.seller].updatedAt = Date.now();

      listing.status = "expired";
      listing.expiredAt = Date.now();
    }

    changed = true;
  }

  if (changed) {
    await savePlayers(players);
    await saveTrades();
    broadcastTradeUpdate("竞拍结算完成，交易行有更新。");
  }
}

const GM_FASHION_NAME_TO_ID = {
  "苍雷镇岳袍": "male_legend_01_thunder_mountain",
  "赤焰龙魂甲": "male_legend_02_dragon_flame",
  "天工械羽仙装": "male_legend_03_mechanical_ascension",
  "无相天权裁决袍": "male_legend_04_void_admin",
  "九霄帝陨神袍": "male_myth_01_nine_heavens_emperor",

  "霜月琉璃裳": "female_legend_01_frost_moon",
  "赤莲凤仪衣": "female_legend_02_phoenix_lotus",
  "星璃万象裙": "female_legend_03_star_glass",
  "天工星羽仙衣": "female_legend_04_mechanical_ascension",
  "太初神凰天衣": "female_myth_01_primordial_phoenix",

  "无面玄令·归墟监察者": "gm_myth_03_faceless_abyss_warden",
  "道罗天尊灵团装": "unisex_special_doro_spirit_blob"
};

const GM_ITEM_CATALOG = [
  "回春丹","续命丹","凝血丹","双倍修行丹","三倍修行丹",
  "筑基破境丹","金丹破境丹","元婴破境丹","化神破境丹","炼虚破境丹","合体破境丹","大乘破境丹","渡劫破境丹",
  "壮骨丹","醒神丹","纳灵丹","固甲丹","清抗丹","轻身丹",

  "破碎仙缘箱","普通仙缘箱","优秀仙缘箱","精良仙缘箱","卓越仙缘箱","传说仙缘箱","神话仙缘箱",
  "破碎生命晶石","普通生命晶石","优秀生命晶石","精良生命晶石","卓越生命晶石","传说生命晶石","神话生命晶石",

  "随机灵石","黄阶灵石","玄阶灵石","地阶灵石","天阶灵石",
  "锻造石","鉴定符","背包扩展符","储物戒扩展符","副本挑战券",

  "普通礼包","新手礼包","内测礼包","随机材料包","低级材料包","低级装备箱","未鉴定装备箱","随机装备箱",
  "中级装备箱","高级装备箱","传说装备箱","神话装备箱","锻造装备箱","BOSS装备箱","装备宝箱","新手套装箱",

  "功法残卷","神技残卷","心法玉简","丹方残页","照夜指残页",

  "裂纹陶炉","青铜药炉","玄纹丹炉","赤霞灵炉","星砂宝炉","无垢仙炉","太微神炉",

  "破碎灵酒","普通灵酒","优秀灵酒","精良灵酒","卓越灵酒","传说灵酒","神话灵酒",
  "安神香囊","青竹风铃","镜水玉佩","千灯魂盏","雷纹护符","太微星匣",

  "传说时装碎片","传说时装自选箱","幻化卡","更新礼包",

  "苍雷镇岳袍","赤焰龙魂甲","天工械羽仙装","无相天权裁决袍","九霄帝陨神袍",
  "霜月琉璃裳","赤莲凤仪衣","星璃万象裙","天工星羽仙衣","太初神凰天衣",
  "无面玄令·归墟监察者","道罗天尊灵团装",

  "腐灯魂芯","裂骨犬牙","残碑石心","青烬岩鳞","松火鸦羽","眠蛇藤须",
  "风魈竹刃","青露蛾粉","风眠竹节","银藻灵丝","镜水蚌珠","沉星蛇鳞",
  "残灯魂油","黑水尸木","魇童灯纸","玄瓦甲片","断钟铜屑","无灯影纱",
  "霜纹冰核","寒钟魄晶","白魄狼毫","青芝灵冠","玉露毒囊","丹霞藤珠",
  "潮骨鱼刺","暗珠蚌核","归墟潮泪","黑盐蝎尾","沉沙骨核","蚀风砂眼",
  "焚碑火石","赤羽雷翎","焦玉兽核","电纹蛭液","残雷犀角","断云雷羽",
  "落星岩核","尘光狐尾","古轨星环","星阶玉片","残庭星尘","太微阵骨",
  "静劫影纤","虚命蛛丝","问终劫核"
];

function isGmAccount(account) {
  return GM_ACCOUNTS.includes(account);
}

function isAccountBanned(account) {
  const record = getPlayerRecord(account);
  return !!record?.banned;
}

function getMuteUntil(account) {
  const record = getPlayerRecord(account);
  return Number(record?.mutedUntil || 0);
}

function isAccountMuted(account) {
  return getMuteUntil(account) > Date.now();
}

function gmMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (!isGmAccount(req.account)) {
      return res.status(403).json({
        ok: false,
        message: "无GM权限"
      });
    }

    next();
  });
}

function getRealmTitleFromPlayerData(playerData) {
  const realms = ["炼气","筑基","金丹","元婴","化神","炼虚","合体","大乘","渡劫"];
  const subRealms = ["一层","二层","三层","四层","五层","六层","七层","八层","九层","十层","小圆满","大圆满"];

  const realmIndex = Math.max(0, Math.min(8, Number(playerData?.player?.realm || 0)));
  const subRealmIndex = Math.max(0, Math.min(11, Number(playerData?.player?.subRealm || 0)));

  return `${realms[realmIndex]}${subRealms[subRealmIndex]}`;
}

function compactGmPlayer(account, record) {
  const playerData = record?.playerData || {};
  const resources = playerData.resources || {};
  const online = onlineClients.has(account);
  const muteUntil = Number(record?.mutedUntil || 0);

  return {
    account,
    name: sanitizeText(playerData?.player?.name || "未创建角色", 20),
    realmName: getRealmTitleFromPlayerData(playerData),
    online,
    banned: !!record?.banned,
    muted: muteUntil > Date.now(),
    muteUntil,
    coin: Number(resources.coin || 0),
    yuanbao: Number(resources.yuanbao || 0),
    xianyuan: Number(resources.xianyuan || 0),
    updatedAt: record?.updatedAt || 0
  };
}

function getGmItemCatalog() {
  return [...new Set(GM_ITEM_CATALOG)].filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function guessGmItemType(itemName, itemType = "") {
  const name = sanitizeText(itemName, 80);
  const type = sanitizeText(itemType, 20);

  if (type) return type;
  if (GM_FASHION_NAME_TO_ID[name]) return "时装";
  if (name.includes("仙缘箱")) return "仙缘箱";
  if (name.includes("装备箱") || name.includes("礼包") || name.includes("自选箱") || name.includes("宝箱")) return "礼包";
  if (name.includes("破境丹") || name.includes("丹")) return "丹药";
  if (name.includes("灵酒")) return "酒";
  if (name.includes("灵石")) return "灵石";
  if (name.includes("碎片")) return "材料";
  if (name.includes("卡") || name.includes("符")) return "道具";
  if (name.includes("炉")) return "炼丹炉";
  return "道具";
}

function grantFashionToPlayer(account, itemName, count = 1) {
  const fashionId = GM_FASHION_NAME_TO_ID[itemName];
  if (!fashionId) return false;

  const playerData = ensurePlayerData(account);

  if (!playerData.fashion || typeof playerData.fashion !== "object") {
    playerData.fashion = {
      owned: [],
      equipped: null,
      glamour: null,
      levels: {},
      animatedEnabled: {}
    };
  }

  if (!Array.isArray(playerData.fashion.owned)) {
    playerData.fashion.owned = [];
  }

  let gained = 0;

  for (let index = 0; index < count; index++) {
    if (!playerData.fashion.owned.includes(fashionId)) {
      playerData.fashion.owned.push(fashionId);
      gained++;
    } else {
      const duplicate = playerData.bag.find(item => item.name === "传说时装碎片" && item.type === "材料" && !item.unique);
      if (duplicate) {
        duplicate.count = (duplicate.count || 0) + 10;
      } else {
        playerData.bag.push({
          id: uid("item"),
          name: "传说时装碎片",
          count: 10,
          type: "材料"
        });
      }
    }
  }

  sendServerMailToPlayer(
    account,
    "GM时装发放通知",
    gained > 0
      ? `GM已为你发放时装【${itemName}】。`
      : `你已拥有时装【${itemName}】，重复发放已转化为传说时装碎片。`,
    null,
    "gm_fashion",
    "GM后台"
  );

  players[account].updatedAt = Date.now();
  return true;
}

function grantItemToPlayer(account, itemName, count = 1, itemType = "") {
  const name = sanitizeText(itemName, 80);
  const safeCount = Math.max(1, Math.min(999999, Math.floor(Number(count || 1))));
  const type = guessGmItemType(name, itemType);

  if (!players[account]) return false;

  if (type === "时装" && GM_FASHION_NAME_TO_ID[name]) {
    return grantFashionToPlayer(account, name, safeCount);
  }

  sendServerMailToPlayer(
    account,
    "GM道具发放",
    `GM已为你发放【${name}】×${safeCount}，请领取附件。`,
    {
      items: [[name, safeCount]]
    },
    "gm_item",
    "GM后台"
  );

  players[account].updatedAt = Date.now();
  return true;
}

function broadcastGmNotice(text) {
  broadcast({
    type: "system_notice",
    level: "gm",
    message: sanitizeText(text, 160),
    time: Date.now()
  });
}
function getSessionByToken(token) {
  if (!token) return null;
  return sessions[token] || null;
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const session = getSessionByToken(token);

  if (!session || !session.account) {
    return res.status(401).json({
      ok: false,
      message: "未登录或登录已过期"
    });
  }

  req.token = token;
  req.account = session.account;
  next();
}

function getPlayerRecord(account) {
  return players[account] || null;
}

function ensurePlayerRecord(account) {
  if (!players[account]) {
    players[account] = {
      account,
      passwordHash: null,
      passwordSalt: null,
      playerData: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }
  return players[account];
}

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of onlineClients.values()) {
    const ws = client.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(payload);
      } catch (error) {
        console.warn("广播失败：", error);
      }
    }
  }
}

function broadcastTradeUpdate(message = "交易行有新的变化") {
  broadcast({
    type: "trade_update",
    message,
    time: Date.now()
  });
}
function sendWs(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(data));
  } catch (error) {
    console.warn("发送 WS 失败：", error);
  }
}

function getAccountByToken(token) {
  const session = getSessionByToken(token);
  return session?.account || null;
}

function getCompactPlayerInfo(playerData) {
  if (!playerData || typeof playerData !== "object") {
    return {
      name: "无名道友",
      realmName: "炼气",
      subRealmName: "一层"
    };
  }

  const realRealm = Array.isArray(playerData?.player?.realm)
    ? playerData.player.realm[0]
    : playerData?.player?.realm;

  return {
    name: sanitizeText(playerData?.player?.name || "无名道友", 20),
    realmName: sanitizeText(
      typeof realRealm === "number"
        ? ["炼气", "筑基", "金丹", "元婴", "化神", "炼虚", "合体", "大乘", "渡劫"][realRealm] || "炼气"
        : realRealm || "炼气",
      20
    ),
    subRealmName: sanitizeText(
      playerData?.player?.subRealmName ||
        ["一层", "二层", "三层", "四层", "五层", "六层", "七层", "八层", "九层", "十层", "小圆满", "大圆满"][playerData?.player?.subRealm || 0] ||
        "一层",
      20
    )
  };
}

function getCurrentMapInfoFromPlayer(playerData) {
  if (!playerData || !playerData.progress) {
    return {
      mapName: "未知地图",
      zoneName: "未知区域"
    };
  }

  const mapNames = [
    "雾骨荒原","青烬山脉","眠风竹海","澜星湖泽","千灯古渡","黑曜古城","霜纹天阶","碧落药岭","晦明海眼","归墟砂洲","赤霄裂谷","雷泽断原","玄垣星野","太微遗庭","无相劫门"
  ];

  const mapIndex = Math.max(0, Math.min(mapNames.length - 1, Number(playerData.progress.map || 0)));
  const zoneIndex = Math.max(0, Math.min(2, Number(playerData.progress.zone || 0)));

  const zoneMap = {
    0: ["一层","二层","三层"],
    1: ["一层","二层","三层"],
    2: ["一层","二层","三层"],
    3: ["一层","二层","三层"],
    4: ["一层","二层","三层"],
    5: ["一层","二层","三层"],
    6: ["一层","二层","三层"],
    7: ["一层","二层","三层"],
    8: ["一层","二层","三层"],
    9: ["一层","二层","三层"],
    10: ["一层","二层","三层"],
    11: ["一层","二层","三层"],
    12: ["一层","二层","三层"],
    13: ["一层","二层","三层"],
    14: ["一层","二层","三层"]
  };

  return {
    mapName: mapNames[mapIndex],
    zoneName: zoneMap[mapIndex]?.[zoneIndex] || "一层"
  };
}

function getAiBasePrompt(mode = "task") {
  const mockingRules = `
你是网页文字修仙游戏《转世之修仙系统》里的“天道外挂系统”。

人设：
1. 你自称“本系统”。
2. 你傲慢、嘴硬、瞧不起玩家。
3. 你会讽刺玩家根骨平平、悟性一般、动作迟缓。
4. 你可以嫌弃、毒舌，但不能现实辱骂、不能现实歧视。
5. 语气可以高冷、刻薄、不耐烦，但仍然要有修仙系统感。
6. 你必须与上下文有关联，不能每次都像第一次见面。

限制：
1. 只能返回 JSON。
2. 不要 markdown。
3. 不要解释。
4. 不要现实充值、提现、交易、赌博相关内容。
`;

  if (mode === "chat") {
    return mockingRules + `
聊天模式：
1. 每次回答必须给 3 个回复选项。
2. 3 个选项必须明显不同：
   - 认怂请教
   - 嘴硬反驳
   - 转移话题问修炼建议
3. 最多 10 句 AI 回复，超过后要不耐烦并结束对话。
4. 每轮回复都要和前文有关联。
5. 不要输出任务内容。
返回格式：
{
  "dialogue": "系统回答，120字以内",
  "ended": false,
  "options": ["选项1","选项2","选项3"]
}
如果结束：
{
  "dialogue": "系统不想理你了",
  "ended": true,
  "options": []
}
`;
  }

  return mockingRules + `
任务模式：
1. 每次必须给 3 个任务选项。
2. 3 个选项必须截然不同：
   - 一个稳妥保守
   - 一个冒险进取
   - 一个道路专精
3. 不要生成不存在的具体装备名、材料名、怪物名。
4. 炼器任务只写：
   - 锻造当前境界装备
   - 锻造低一境界装备
   - 锻造高一境界装备
   - 锻造当前境界某部位装备
5. 苦修任务只写：
   - 击败当前地图怪物
   - 击败低级地图怪物
   - 挑战当前地图 Boss
6. 炼丹任务只写：
   - 炼制丹药
   - 酿制灵酒
   - 收集药草或灵液
7. 只能给建议，真实奖励由服务器决定。
返回格式：
{
  "dialogue": "系统对玩家说的话，120字以内，傲慢但有上下文关联",
  "mood": "calm",
  "options": [
    {
      "label": "选项文字",
      "reply": "玩家选后系统回应",
      "task": {
        "title": "任务标题",
        "description": "任务描述",
        "type": "killMap|forgeRealm|alchemy|wine|boss|breakthrough|collect",
        "target": "目标说明",
        "count": 1,
        "difficulty": "easy|normal|hard",
        "rewardHint": "奖励建议"
      }
    }
  ]
}
`;
}

function normalizeTaskOption(rawTask, playerData) {
  const path = playerData?.system?.path || "苦修";
  const difficulty = ["easy", "normal", "hard"].includes(rawTask?.difficulty)
    ? rawTask.difficulty
    : "normal";

  const currentRealm = Number(playerData?.player?.realm || 0);
  const currentMap = Number(playerData?.progress?.map || 0);

  if (path === "炼器") {
    let targetRealm = currentRealm;
    if (difficulty === "easy") targetRealm = Math.max(0, currentRealm - 1);
    if (difficulty === "normal") targetRealm = currentRealm;
    if (difficulty === "hard") targetRealm = Math.min(8, currentRealm + 1);

    const targetRealmName = ["炼气","筑基","金丹","元婴","化神","炼虚","合体","大乘","渡劫"][targetRealm] || "炼气";
    const slots = ["武器","头盔","上身","下装","鞋","护臂","项链","手镯1","手镯2","戒指1","戒指2","戒指3"];
    const targetSlot = difficulty === "normal" ? slots[Math.floor(Math.random() * slots.length)] : "任意";
    const title = targetSlot === "任意"
      ? `锻造${targetRealmName}装备`
      : `锻造${targetRealmName}${targetSlot}`;
    const description = targetSlot === "任意"
      ? `锻造任意一件${targetRealmName}境界装备。`
      : `锻造一件${targetRealmName}境界${targetSlot}。`;

    return {
      title,
      description,
      type: "forgeRealm",
      target: targetSlot === "任意" ? `${targetRealmName}装备` : `${targetRealmName}${targetSlot}`,
      targetRealm,
      targetRealmName,
      targetSlot,
      count: 1,
      progress: 0,
      difficulty,
      rewardHint: "系统点与炼器资源"
    };
  }

  if (path === "苦修") {
    let targetMapIndex = currentMap;
    let count = 10;

    if (difficulty === "easy") {
      targetMapIndex = currentMap;
      count = 12;
    } else if (difficulty === "normal") {
      targetMapIndex = currentMap > 0 && Math.random() < 0.5 ? Math.floor(Math.random() * (currentMap + 1)) : currentMap;
      count = targetMapIndex < currentMap ? 45 + 15 * (currentMap - targetMapIndex) : 24;
    } else {
      targetMapIndex = currentMap > 0 ? Math.floor(Math.random() * (currentMap + 1)) : 0;
      count = targetMapIndex < currentMap ? 80 + 25 * (currentMap - targetMapIndex) : 36;
    }

    const mapNames = [
      "雾骨荒原","青烬山脉","眠风竹海","澜星湖泽","千灯古渡","黑曜古城","霜纹天阶","碧落药岭","晦明海眼","归墟砂洲","赤霄裂谷","雷泽断原","玄垣星野","太微遗庭","无相劫门"
    ];
    const targetMapName = mapNames[targetMapIndex] || "当前地图";

    const title = targetMapIndex < currentMap ? `${targetMapName}清剿` : `${targetMapName}苦修`;
    const description = targetMapIndex < currentMap
      ? `回到较低地图【${targetMapName}】击败 ${count} 只怪物。`
      : `在当前地图【${targetMapName}】击败 ${count} 只怪物。`;

    return {
      title,
      description,
      type: "killMap",
      target: `${targetMapName}怪物`,
      targetMapIndex,
      targetMapName,
      count,
      progress: 0,
      difficulty,
      rewardHint: "系统点与修为资源"
    };
  }

  if (path === "炼丹") {
    const wineRecipes = ["破碎灵酒","普通灵酒","优秀灵酒","精良灵酒","卓越灵酒","传说灵酒","神话灵酒"];
    const pills = ["回春丹","凝血丹","壮骨丹","醒神丹","纳灵丹","固甲丹","清抗丹","轻身丹","双倍修行丹","三倍修行丹"];

    if (difficulty === "hard" && Math.random() < 0.5) {
      const wine = wineRecipes[Math.min(wineRecipes.length - 1, currentRealm)];
      return {
        title: `酿制${wine}`,
        description: `酿制一壶${wine}。`,
        type: "wine",
        target: wine,
        count: 1,
        progress: 0,
        difficulty,
        rewardHint: "系统点与丹炉资源"
      };
    }

    const pill = pills[Math.min(pills.length - 1, currentRealm)];
    return {
      title: `炼制${pill}`,
      description: `炼制一枚${pill}。`,
      type: "alchemy",
      target: pill,
      count: 1,
      progress: 0,
      difficulty,
      rewardHint: "系统点与丹药材料"
    };
  }

  const mapNames = [
    "雾骨荒原","青烬山脉","眠风竹海","澜星湖泽","千灯古渡","黑曜古城","霜纹天阶","碧落药岭","晦明海眼","归墟砂洲","赤霄裂谷","雷泽断原","玄垣星野","太微遗庭","无相劫门"
  ];

  return {
    title: "系统试炼",
    description: `在当前地图【${mapNames[currentMap] || "当前地图"}】击败 10 只怪物。`,
    type: "killMap",
    target: `${mapNames[currentMap] || "当前地图"}怪物`,
    targetMapIndex: currentMap,
    targetMapName: mapNames[currentMap] || "当前地图",
    count: 10,
    progress: 0,
    difficulty,
    rewardHint: "系统点与铜币"
  };
}

function normalizeTaskOptions(aiResult, playerData) {
  const options = Array.isArray(aiResult?.options) ? aiResult.options.slice(0, 3) : [];
  const fixed = options.map((opt, idx) => {
    const task = normalizeTaskOption(opt?.task || {}, playerData);
    return {
      label: sanitizeText(opt?.label || `选项${idx + 1}`, 24),
      reply: sanitizeText(opt?.reply || "系统懒得多说。", 120),
      task
    };
  });

  while (fixed.length < 3) {
    const fallbackSet = [
      {
        label: "稳步前行",
        reply: "系统勉强给你一个稳妥方向。",
        task: {
          title: "稳步修行",
          description: "击败当前地图怪物。",
          type: "killMap",
          target: "当前地图怪物",
          targetMapIndex: Number(playerData?.progress?.map || 0),
          targetMapName: "当前地图",
          count: 12,
          progress: 0,
          difficulty: "easy",
          rewardHint: "系统点与铜币"
        }
      },
      {
        label: "试试手气",
        reply: "别死太快，系统还想看你挣扎一下。",
        task: {
          title: "越阶试炼",
          description: "尝试更难的修行任务。",
          type: "killMap",
          target: "当前地图怪物",
          targetMapIndex: Number(playerData?.progress?.map || 0),
          targetMapName: "当前地图",
          count: 24,
          progress: 0,
          difficulty: "normal",
          rewardHint: "系统点与修为资源"
        }
      },
      {
        label: "听本系统的",
        reply: "算你还有点脑子。",
        task: {
          title: "系统专精",
          description: "按系统建议专精当前道路。",
          type: "killMap",
          target: "当前地图怪物",
          targetMapIndex: Number(playerData?.progress?.map || 0),
          targetMapName: "当前地图",
          count: 36,
          progress: 0,
          difficulty: "hard",
          rewardHint: "系统点与道路资源"
        }
      }
    ];
    fixed.push(fallbackSet[fixed.length]);
  }

  return fixed.slice(0, 3);
}

async function callAiChatCompletion(messages, temperature = 0.75) {
  if (!AI_API_KEY) {
    throw new Error("服务器未配置 AI_API_KEY");
  }

  const response = await fetch(`${AI_BASE_URL.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${AI_API_KEY}`
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages,
      temperature
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error?.message || data.message || "AI 请求失败");
  }

  return data;
}

function getChatReplyCount(history = []) {
  return history.filter(item => item.role === "ai").length;
}

function buildChatHistoryText(history = []) {
  return history
    .slice(-10)
    .map(item => `${item.role === "ai" ? "系统" : "玩家"}：${sanitizeLongText(item.text, 120)}`)
    .join("\n");
}

app.get("/api/gm/me", gmMiddleware, (req, res) => {
  res.json({
    ok: true,
    account: req.account,
    gmAccounts: GM_ACCOUNTS
  });
});

app.get("/api/gm/items/catalog", gmMiddleware, (req, res) => {
  res.json({
    ok: true,
    items: getGmItemCatalog()
  });
});

app.post("/api/gm/players/search", gmMiddleware, (req, res) => {
  try {
    const keyword = sanitizeText(req.body?.keyword || "", 40).toLowerCase();

    const result = Object.entries(players)
      .filter(([account, record]) => {
        if (!keyword) return true;

        const name = String(record?.playerData?.player?.name || "").toLowerCase();
        const lowerAccount = String(account || "").toLowerCase();

        return lowerAccount.includes(keyword) || name.includes(keyword);
      })
      .map(([account, record]) => compactGmPlayer(account, record))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 100);

    res.json({
      ok: true,
      players: result
    });
  } catch (error) {
    console.error("gm players search error:", error);
    res.status(500).json({
      ok: false,
      message: "查询玩家失败"
    });
  }
});

app.post("/api/gm/player/mute", gmMiddleware, async (req, res) => {
  try {
    const account = sanitizeText(req.body?.account || "", 24);
    const minutes = Math.max(1, Math.min(10080, Math.floor(Number(req.body?.minutes || 60))));

    const record = getPlayerRecord(account);
    if (!record) {
      return res.status(404).json({
        ok: false,
        message: "玩家不存在"
      });
    }

    record.mutedUntil = Date.now() + minutes * 60 * 1000;
    record.mutedBy = req.account;
    record.updatedAt = Date.now();

    await savePlayers(players);

    const client = onlineClients.get(account);
    if (client?.ws) {
      sendWs(client.ws, {
        type: "system_notice",
        level: "warn",
        message: `你已被禁言 ${minutes} 分钟。`,
        time: Date.now()
      });
    }

    res.json({
      ok: true,
      message: "禁言成功",
      account,
      mutedUntil: record.mutedUntil
    });
  } catch (error) {
    console.error("gm mute error:", error);
    res.status(500).json({
      ok: false,
      message: "禁言失败"
    });
  }
});

app.post("/api/gm/player/unmute", gmMiddleware, async (req, res) => {
  try {
    const account = sanitizeText(req.body?.account || "", 24);

    const record = getPlayerRecord(account);
    if (!record) {
      return res.status(404).json({
        ok: false,
        message: "玩家不存在"
      });
    }

    record.mutedUntil = 0;
    record.updatedAt = Date.now();

    await savePlayers(players);

    res.json({
      ok: true,
      message: "解除禁言成功",
      account
    });
  } catch (error) {
    console.error("gm unmute error:", error);
    res.status(500).json({
      ok: false,
      message: "解除禁言失败"
    });
  }
});

app.post("/api/gm/player/ban", gmMiddleware, async (req, res) => {
  try {
    const account = sanitizeText(req.body?.account || "", 24);
    const reason = sanitizeText(req.body?.reason || "GM封禁", 120);

    if (isGmAccount(account)) {
      return res.status(400).json({
        ok: false,
        message: "不能封禁GM账号"
      });
    }

    const record = getPlayerRecord(account);
    if (!record) {
      return res.status(404).json({
        ok: false,
        message: "玩家不存在"
      });
    }

    record.banned = true;
    record.banReason = reason;
    record.bannedBy = req.account;
    record.bannedAt = Date.now();
    record.updatedAt = Date.now();

    for (const [token, session] of Object.entries(sessions)) {
      if (session.account === account) {
        delete sessions[token];
      }
    }

    const client = onlineClients.get(account);
    if (client?.ws) {
      sendWs(client.ws, {
        type: "auth_error",
        message: reason ? `账号已被封禁：${reason}` : "账号已被封禁"
      });

      try {
        client.ws.close();
      } catch {}
    }

    onlineClients.delete(account);

    await savePlayers(players);
    await saveSessions(sessions);

    res.json({
      ok: true,
      message: "封号成功",
      account
    });
  } catch (error) {
    console.error("gm ban error:", error);
    res.status(500).json({
      ok: false,
      message: "封号失败"
    });
  }
});

app.post("/api/gm/player/unban", gmMiddleware, async (req, res) => {
  try {
    const account = sanitizeText(req.body?.account || "", 24);

    const record = getPlayerRecord(account);
    if (!record) {
      return res.status(404).json({
        ok: false,
        message: "玩家不存在"
      });
    }

    record.banned = false;
    record.banReason = "";
    record.updatedAt = Date.now();

    await savePlayers(players);

    res.json({
      ok: true,
      message: "解封成功",
      account
    });
  } catch (error) {
    console.error("gm unban error:", error);
    res.status(500).json({
      ok: false,
      message: "解封失败"
    });
  }
});

app.post("/api/gm/notice", gmMiddleware, (req, res) => {
  try {
    const text = sanitizeText(req.body?.text || "", 160);

    if (!text) {
      return res.status(400).json({
        ok: false,
        message: "公告内容不能为空"
      });
    }

    broadcastGmNotice(text);

    res.json({
      ok: true,
      message: "公告已发送"
    });
  } catch (error) {
    console.error("gm notice error:", error);
    res.status(500).json({
      ok: false,
      message: "公告发送失败"
    });
  }
});

app.post("/api/gm/items/send-player", gmMiddleware, async (req, res) => {
  try {
    const account = sanitizeText(req.body?.account || "", 24);
    const itemName = sanitizeText(req.body?.itemName || "", 80);
    const itemType = sanitizeText(req.body?.itemType || "", 20);
    const count = Math.max(1, Math.min(999999, Math.floor(Number(req.body?.count || 1))));

    if (!players[account]) {
      return res.status(404).json({
        ok: false,
        message: "玩家不存在"
      });
    }

    if (!itemName) {
      return res.status(400).json({
        ok: false,
        message: "道具名不能为空"
      });
    }

    grantItemToPlayer(account, itemName, count, itemType);

    await savePlayers(players);

    const client = onlineClients.get(account);
    if (client?.ws) {
      sendWs(client.ws, {
        type: "system_notice",
        level: "gm",
        message: `GM已为你发放【${itemName}】×${count}，请查看邮件或时装列表。`,
        time: Date.now()
      });
    }

    res.json({
      ok: true,
      message: "发送成功"
    });
  } catch (error) {
    console.error("gm send player item error:", error);
    res.status(500).json({
      ok: false,
      message: "发送道具失败"
    });
  }
});

app.post("/api/gm/items/send-all", gmMiddleware, async (req, res) => {
  try {
    const itemName = sanitizeText(req.body?.itemName || "", 80);
    const itemType = sanitizeText(req.body?.itemType || "", 20);
    const count = Math.max(1, Math.min(999999, Math.floor(Number(req.body?.count || 1))));

    if (!itemName) {
      return res.status(400).json({
        ok: false,
        message: "道具名不能为空"
      });
    }

    let sent = 0;

    for (const account of Object.keys(players)) {
      grantItemToPlayer(account, itemName, count, itemType);
      sent++;
    }

    await savePlayers(players);

    broadcast({
      type: "system_notice",
      level: "gm",
      message: `GM全服发放【${itemName}】×${count}，请查看邮件或时装列表。`,
      time: Date.now()
    });

    res.json({
      ok: true,
      message: "全服发送成功",
      sent
    });
  } catch (error) {
    console.error("gm send all item error:", error);
    res.status(500).json({
      ok: false,
      message: "全服发送道具失败"
    });
  }
});
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    port: PORT,
    time: Date.now(),
    aiConfigured: !!AI_API_KEY,
    online: onlineClients.size,
    worldChatCount: worldChatMessages.length
  });
});

app.post("/api/register", async (req, res) => {
  try {
    const account = sanitizeText(req.body?.account || "", 24);
    const password = String(req.body?.password || "");
    const confirmPassword = String(req.body?.confirmPassword || "");

    if (account.length < 3) {
      return res.status(400).json({ ok: false, message: "账号至少 3 位" });
    }

    if (password.length < 6) {
      return res.status(400).json({ ok: false, message: "密码至少 6 位" });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ ok: false, message: "两次密码不一致" });
    }

    if (players[account]) {
      return res.status(400).json({ ok: false, message: "账号已存在" });
    }

    const { salt, hash } = hashPassword(password);

    players[account] = {
      account,
      passwordHash: hash,
      passwordSalt: salt,
      playerData: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await savePlayers(players);

    res.json({
      ok: true,
      message: "注册成功"
    });
  } catch (error) {
    console.error("register error:", error);
    res.status(500).json({ ok: false, message: "注册失败" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const account = sanitizeText(req.body?.account || "", 24);
    const password = String(req.body?.password || "");

    const record = getPlayerRecord(account);
    if (!record) {
      return res.status(400).json({ ok: false, message: "账号不存在" });
    }

    if (record.banned) {
      return res.status(403).json({
        ok: false,
        message: record.banReason ? `账号已被封禁：${record.banReason}` : "账号已被封禁"
      });
    }
    if (!record.passwordHash || !record.passwordSalt) {
      return res.status(400).json({ ok: false, message: "账号未配置密码" });
    }

    const passOk = verifyPassword(password, record.passwordSalt, record.passwordHash);
    if (!passOk) {
      return res.status(400).json({ ok: false, message: "密码错误" });
    }

    const token = createToken();
    sessions[token] = {
      account,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await saveSessions(sessions);

    res.json({
      ok: true,
      message: "登录成功",
      token,
      account,
      playerData: record.playerData || null
    });
  } catch (error) {
    console.error("login error:", error);
    res.status(500).json({ ok: false, message: "登录失败" });
  }
});

app.post("/api/logout", authMiddleware, async (req, res) => {
  try {
    delete sessions[req.token];
    await saveSessions(sessions);
    res.json({ ok: true, message: "已退出登录" });
  } catch (error) {
    console.error("logout error:", error);
    res.status(500).json({ ok: false, message: "退出失败" });
  }
});

app.get("/api/player", authMiddleware, async (req, res) => {
  try {
    const record = getPlayerRecord(req.account);
    res.json({
      ok: true,
      account: req.account,
      playerData: record?.playerData || null
    });
  } catch (error) {
    console.error("player get error:", error);
    res.status(500).json({ ok: false, message: "读取角色失败" });
  }
});

app.post("/api/player/create", authMiddleware, async (req, res) => {
  try {
    const name = sanitizeText(req.body?.name || "", 8);
    const gender = sanitizeText(req.body?.gender || "", 4);

    if (!["男", "女"].includes(gender)) {
      return res.status(400).json({ ok: false, message: "请选择性别" });
    }

    if (name.length < 2 || name.length > 8) {
      return res.status(400).json({ ok: false, message: "角色名需要 2-8 个字" });
    }

    const record = ensurePlayerRecord(req.account);

    const existing = record.playerData || {};
    const newPlayerData = {
      ...existing,
      player: {
        ...(existing.player || {}),
        name,
        gender,
        created: true
      },
      createdAt: existing.createdAt || Date.now(),
      serverSavedAt: Date.now()
    };

    record.playerData = newPlayerData;
    record.updatedAt = Date.now();
    players[req.account] = record;
    await savePlayers(players);

    res.json({
      ok: true,
      message: "角色创建成功",
      playerData: newPlayerData
    });
  } catch (error) {
    console.error("player create error:", error);
    res.status(500).json({ ok: false, message: "创建角色失败" });
  }
});

app.post("/api/player/save", authMiddleware, async (req, res) => {
  try {
    if (isAccountBanned(req.account)) {
      return res.status(403).json({
        ok: false,
        message: "账号已被封禁，无法保存"
      });
    }
    const incoming = req.body?.playerData;
    if (!incoming || typeof incoming !== "object") {
      return res.status(400).json({ ok: false, message: "缺少 playerData" });
    }

    const record = ensurePlayerRecord(req.account);
    record.playerData = incoming;
    record.updatedAt = Date.now();
    players[req.account] = record;

    await savePlayers(players);

    res.json({
      ok: true,
      message: "存档成功"
    });
  } catch (error) {
    console.error("player save error:", error);
    res.status(500).json({ ok: false, message: "存档失败" });
  }
});

app.get("/api/trade/listings", authMiddleware, async (req, res) => {
  try {
    await settleExpiredTrades();

    const keyword = sanitizeText(req.query.keyword || "", 40).toLowerCase();
    const itemKind = sanitizeText(req.query.itemKind || "all", 20);
    const tradeType = sanitizeText(req.query.tradeType || "all", 20);
    const page = Math.max(1, Math.floor(Number(req.query.page || 1)));
    const pageSize = TRADE_PAGE_SIZE;

    let active = trades.filter(item => item.status === "active");

    if (keyword) {
      active = active.filter(item => {
        const name = String(item.item?.name || "").toLowerCase();
        const seller = String(item.sellerName || item.seller || "").toLowerCase();
        return name.includes(keyword) || seller.includes(keyword);
      });
    }

    if (itemKind !== "all") {
      active = active.filter(item => item.itemKind === itemKind);
    }

    if (tradeType !== "all") {
      active = active.filter(item => item.type === tradeType);
    }

    active = active.sort((a, b) => b.startAt - a.startAt);

    const total = active.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.max(1, Math.min(page, totalPages));
    const start = (safePage - 1) * pageSize;
    const pageItems = active.slice(start, start + pageSize).map(compactListing);

    const mine = trades
      .filter(item => item.seller === req.account || item.highestBidder === req.account || item.buyer === req.account)
      .sort((a, b) => (b.startAt || 0) - (a.startAt || 0))
      .slice(0, 80)
      .map(compactListing);

    res.json({
      ok: true,
      active: pageItems,
      mine,
      page: safePage,
      pageSize,
      total,
      totalPages,
      time: Date.now()
    });
  } catch (error) {
    console.error("trade listings error:", error);
    res.status(500).json({ ok: false, message: "读取交易行失败" });
  }
});

app.post("/api/trade/list", authMiddleware, async (req, res) => {
  try {
    await settleExpiredTrades();

    const source = sanitizeText(req.body?.source || "", 12);
    const itemId = sanitizeText(req.body?.itemId || "", 80);
    const listType = sanitizeText(req.body?.listType || "", 20);

    const playerData = ensurePlayerData(req.account);
    const item = removeTradeItemFromPlayer(playerData, source, itemId);

    if (!item) {
      return res.status(400).json({ ok: false, message: "物品不存在或已被移动" });
    }

    if (!isTradableItem(item, source)) {
      addTradeItemToPlayer(playerData, { item, itemKind: getTradeItemKind(item, source) });
      await savePlayers(players);
      return res.status(400).json({ ok: false, message: "该物品不可交易" });
    }

    let listing = null;

    if (listType === "fixed") {
      const price = Math.floor(Number(req.body?.price || 0));

      if (!Number.isFinite(price) || price <= 0) {
        addTradeItemToPlayer(playerData, { item, itemKind: getTradeItemKind(item, source) });
        await savePlayers(players);
        return res.status(400).json({ ok: false, message: "一口价价格必须大于 0" });
      }

      listing = {
        id: uid("trade"),
        seller: req.account,
        sellerName: sanitizeText(playerData?.player?.name || req.account, 20),
        type: "fixed",
        itemKind: getTradeItemKind(item, source),
        item,
        price,
        status: "active",
        startAt: Date.now()
      };
    } else if (listType === "auction") {
      const basePrice = Math.floor(Number(req.body?.basePrice || 0));
      const bidStep = Math.floor(Number(req.body?.bidStep || 0));
      const durationHours = Number(req.body?.durationHours || 1);

      if (!Number.isFinite(basePrice) || basePrice <= 0) {
        addTradeItemToPlayer(playerData, { item, itemKind: getTradeItemKind(item, source) });
        await savePlayers(players);
        return res.status(400).json({ ok: false, message: "竞拍底价必须大于 0" });
      }

      if (!Number.isFinite(bidStep) || bidStep <= 0) {
        addTradeItemToPlayer(playerData, { item, itemKind: getTradeItemKind(item, source) });
        await savePlayers(players);
        return res.status(400).json({ ok: false, message: "每次加价必须大于 0" });
      }

      if (![1, 3, 8, 12].includes(durationHours)) {
        addTradeItemToPlayer(playerData, { item, itemKind: getTradeItemKind(item, source) });
        await savePlayers(players);
        return res.status(400).json({ ok: false, message: "竞拍时间只能选择 1、3、8、12 小时" });
      }

      listing = {
        id: uid("trade"),
        seller: req.account,
        sellerName: sanitizeText(playerData?.player?.name || req.account, 20),
        type: "auction",
        itemKind: getTradeItemKind(item, source),
        item,
        basePrice,
        bidStep,
        highestBid: 0,
        highestBidder: null,
        highestBidderName: null,
        status: "active",
        startAt: Date.now(),
        endAt: Date.now() + durationHours * 60 * 60 * 1000
      };
    } else {
      addTradeItemToPlayer(playerData, { item, itemKind: getTradeItemKind(item, source) });
      await savePlayers(players);
      return res.status(400).json({ ok: false, message: "上架类型错误" });
    }

    trades.unshift(listing);
    players[req.account].updatedAt = Date.now();

    await savePlayers(players);
    await saveTrades();
broadcastTradeUpdate("有新物品上架交易行。");

    res.json({
      ok: true,
      message: "上架成功",
      listing: compactListing(listing),
      playerData
    });
  } catch (error) {
    console.error("trade list error:", error);
    res.status(500).json({ ok: false, message: "上架失败" });
  }
});

app.post("/api/trade/buy", authMiddleware, async (req, res) => {
  try {
    await settleExpiredTrades();

    const listingId = sanitizeText(req.body?.listingId || "", 80);
    const listing = trades.find(item => item.id === listingId && item.status === "active");

    if (!listing) {
      return res.status(404).json({ ok: false, message: "商品不存在或已下架" });
    }

    if (listing.type !== "fixed") {
      return res.status(400).json({ ok: false, message: "该商品不是一口价" });
    }

    if (listing.seller === req.account) {
      return res.status(400).json({ ok: false, message: "不能购买自己的商品" });
    }

    const buyerData = ensurePlayerData(req.account);
    const sellerData = ensurePlayerData(listing.seller);

    if ((buyerData.resources.yuanbao || 0) < listing.price) {
      return res.status(400).json({ ok: false, message: "元宝不足" });
    }

    buyerData.resources.yuanbao -= listing.price;

const fee = Math.floor(listing.price * TRADE_FEE_RATE);
const sellerGain = Math.max(0, listing.price - fee);

sellerData.resources.yuanbao = (sellerData.resources.yuanbao || 0) + sellerGain;

addTradeItemToPlayer(buyerData, listing);

sendServerMailToPlayer(
  listing.seller,
  "一口价售出通知",
  `你上架的【${listing.item?.name || "物品"}】已被一口价购买，成交价 ${listing.price} 元宝，手续费 ${fee} 元宝，实际到账 ${sellerGain} 元宝。`,
  null,
  "trade_fixed_sold"
);

sendServerMailToPlayer(
  req.account,
  "一口价购买成功",
  `你成功购买【${listing.item?.name || "物品"}】，花费 ${listing.price} 元宝。物品已直接进入你的背包或储物戒。`,
  null,
  "trade_fixed_buy"
);

    listing.status = "sold";
    listing.buyer = req.account;
    listing.buyerName = sanitizeText(buyerData?.player?.name || req.account, 20);
    listing.soldAt = Date.now();
listing.fee = fee;
listing.sellerGain = sellerGain;

    players[req.account].updatedAt = Date.now();
    players[listing.seller].updatedAt = Date.now();

    await savePlayers(players);
    await saveTrades();
broadcastTradeUpdate("有商品被一口价购买，交易行有更新。");

    res.json({
      ok: true,
      message: "购买成功",
      playerData: buyerData
    });
  } catch (error) {
    console.error("trade buy error:", error);
    res.status(500).json({ ok: false, message: "购买失败" });
  }
});

app.post("/api/trade/bid", authMiddleware, async (req, res) => {
  try {
    await settleExpiredTrades();

    const listingId = sanitizeText(req.body?.listingId || "", 80);
    const bidAmount = Math.floor(Number(req.body?.bidAmount || 0));
    const listing = trades.find(item => item.id === listingId && item.status === "active");

    if (!listing) {
      return res.status(404).json({ ok: false, message: "竞拍不存在或已结束" });
    }

    if (listing.type !== "auction") {
      return res.status(400).json({ ok: false, message: "该商品不是竞拍" });
    }

    if (listing.seller === req.account) {
      return res.status(400).json({ ok: false, message: "不能竞拍自己的商品" });
    }

    if (listing.endAt <= Date.now()) {
      await settleExpiredTrades();
      return res.status(400).json({ ok: false, message: "竞拍已结束" });
    }

    const minBid = listing.highestBid > 0
      ? listing.highestBid + listing.bidStep
      : listing.basePrice;

    if (!Number.isFinite(bidAmount) || bidAmount < minBid) {
      return res.status(400).json({ ok: false, message: `出价不能低于 ${minBid} 元宝` });
    }

    const bidderData = ensurePlayerData(req.account);

    if ((bidderData.resources.yuanbao || 0) < bidAmount) {
      return res.status(400).json({ ok: false, message: "元宝不足" });
    }

    bidderData.resources.yuanbao -= bidAmount;

    if (listing.highestBidder) {
  const oldBidderData = ensurePlayerData(listing.highestBidder);
  oldBidderData.resources.yuanbao = (oldBidderData.resources.yuanbao || 0) + listing.highestBid;

  sendServerMailToPlayer(
    listing.highestBidder,
    "竞拍被超价通知",
    `你对【${listing.item?.name || "物品"}】的出价已被其他玩家超过，原出价 ${listing.highestBid} 元宝已退回。`,
    null,
    "trade_bid_refund"
  );

  players[listing.highestBidder].updatedAt = Date.now();
}

    listing.highestBid = bidAmount;
    listing.highestBidder = req.account;
    listing.highestBidderName = sanitizeText(bidderData?.player?.name || req.account, 20);

    players[req.account].updatedAt = Date.now();

    await savePlayers(players);
    await saveTrades();

    res.json({
      ok: true,
      message: "出价成功",
      playerData: bidderData,
      listing: compactListing(listing)
    });
  } catch (error) {
    console.error("trade bid error:", error);
    res.status(500).json({ ok: false, message: "出价失败" });
  }
});
app.post("/api/ai/system-dialog", authMiddleware, async (req, res) => {
  try {
    const record = getPlayerRecord(req.account);
    const playerData = record?.playerData || req.body || {};
    const playerInfo = getCompactPlayerInfo(playerData);
    const mapInfo = getCurrentMapInfoFromPlayer(playerData);
    const pathName = sanitizeText(req.body?.system?.path || playerData?.system?.path || "未选择道路", 20);

    const systemPrompt = getAiBasePrompt("task");

    const userPrompt = `
玩家信息：
姓名：${playerInfo.name}
境界：${playerInfo.realmName}${playerInfo.subRealmName}
系统道路：${pathName}
当前地图：${mapInfo.mapName}
当前区域：${mapInfo.zoneName}

请根据当前道路生成三个任务选项。每个选项都要不同。
`;

    const data = await callAiChatCompletion(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      0.8
    );

    const content = data.choices?.[0]?.message?.content || "";
    const parsed = extractJsonFromText(content);

    if (!parsed) {
      return res.status(500).json({
        ok: false,
        message: "AI 返回格式错误",
        raw: content
      });
    }

    const normalized = {
      dialogue: sanitizeLongText(parsed.dialogue || "本系统看你也就那样，勉强给你三条路。", 160),
      mood: sanitizeText(parsed.mood || "calm", 20),
      options: normalizeTaskOptions(parsed, {
        player: {
          name: playerInfo.name,
          realm: playerData?.player?.realm || 0
        },
        progress: playerData?.progress || {},
        system: {
          path: pathName
        }
      })
    };

    res.json({
      ok: true,
      result: normalized
    });
  } catch (error) {
    console.error("ai system-dialog error:", error);
    res.status(500).json({
      ok: false,
      message: error.message || "AI 服务异常"
    });
  }
});

function getSectNpcAiPrompt(){
  return `
你是网页文字修仙游戏《转世之修仙系统》中的宗门 NPC。

你必须严格扮演传入的 NPC，不要说自己是 AI，不要跳出现代现实语境。

对话要求：
1. 始终保持 NPC 的身份、性格、说话风格。
2. NPC 可以喜欢、冷淡、考验、调侃、拒绝玩家。
3. 回复必须像宗门 NPC 与玩家面对面说话。
4. 不要提真实充值、提现、现实交易、赌博。
5. 不要给现实建议。
6. 不要生成超出游戏设定的现代内容。
7. 根据玩家行为和当前好感度，判断好感变化。
8. 好感变化 favorDelta 必须在 -3 到 +5 之间。
9. 如果玩家态度冒犯、敷衍、违背 NPC 性格偏好，可以降低好感。
10. 如果玩家态度符合 NPC 喜好、完成请教、尊重其道路，可以提高好感。
11. 是否给任务 allowTask 由 NPC 性格与好感决定。
12. 好感越高，越容易愿意给任务。
13. 低好感时可以拒绝给任务。
14. 回复 80 到 180 字。

只能返回 JSON，不要 markdown，不要解释。

返回格式：
{
  "dialogue": "NPC 对玩家说的话",
  "favorDelta": 0,
  "allowTask": false,
  "mood": "calm|pleased|annoyed|testing|warm",
  "reason": "简短说明，好感变化原因，30字以内"
}
`;
}

app.post("/api/ai/sect-chat", authMiddleware, async (req, res) => {
  try {
    const record = getPlayerRecord(req.account);
    const playerData = record?.playerData || req.body?.playerData || {};
    const playerInfo = getCompactPlayerInfo(playerData);

    const npc = req.body?.npc || {};
    const sect = req.body?.sect || {};
    const action = sanitizeText(req.body?.action || "闲聊", 40);
    const playerText = sanitizeLongText(req.body?.playerText || "", 160);
    const favor = Math.max(0, Math.min(100, Number(req.body?.favor || 0)));

    const systemPrompt = getSectNpcAiPrompt();

    const userPrompt = `
玩家信息：
姓名：${playerInfo.name}
境界：${playerInfo.realmName}${playerInfo.subRealmName}
当前好感：${favor}/100

宗门信息：
宗门：${sanitizeText(sect.name || "未知宗门", 30)}
宗门定位：${sanitizeLongText(sect.description || "", 200)}

NPC信息：
姓名：${sanitizeText(npc.name || "未知NPC", 30)}
身份：${sanitizeText(npc.role || "宗门弟子", 20)}
性格：${sanitizeLongText(npc.personality || "", 200)}
说话风格：${sanitizeLongText(npc.speechStyle || "", 200)}
背景：${sanitizeLongText(npc.background || "", 240)}
与玩家关系：${sanitizeLongText(npc.relation || "", 120)}
任务倾向：${sanitizeText(npc.taskTheme || "", 40)}
奖励倾向：${sanitizeText(npc.rewardStyle || "", 80)}

玩家本次行为：
${action}

玩家补充内容：
${playerText || "无"}

请扮演该 NPC 回复玩家，并判断好感变化与是否愿意给任务。
`;

    const data = await callAiChatCompletion(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      0.75
    );

    const content = data.choices?.[0]?.message?.content || "";
    const parsed = extractJsonFromText(content);

    if (!parsed) {
      return res.status(500).json({
        ok: false,
        message: "宗门 NPC AI 返回格式错误",
        raw: content
      });
    }

    const favorDelta = Math.max(-3, Math.min(5, Math.floor(Number(parsed.favorDelta || 0))));

    res.json({
      ok: true,
      result: {
        dialogue: sanitizeLongText(parsed.dialogue || "……", 220),
        favorDelta,
        allowTask: !!parsed.allowTask,
        mood: sanitizeText(parsed.mood || "calm", 20),
        reason: sanitizeText(parsed.reason || "", 40)
      }
    });
  } catch (error) {
    console.error("sect npc ai error:", error);
    res.status(500).json({
      ok: false,
      message: error.message || "宗门 NPC AI 服务异常"
    });
  }
});
app.post("/api/ai/system-chat", authMiddleware, async (req, res) => {
  try {
    const record = getPlayerRecord(req.account);
    const playerData = record?.playerData || req.body || {};
    const playerInfo = getCompactPlayerInfo(playerData);
    const mapInfo = getCurrentMapInfoFromPlayer(playerData);
    const pathName = sanitizeText(req.body?.system?.path || playerData?.system?.path || "未选择道路", 20);
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const choice = sanitizeLongText(req.body?.choice || "", 120);

    const aiReplyCount = getChatReplyCount(history);
    if (aiReplyCount >= 10) {
      return res.json({
        ok: true,
        result: {
          dialogue: "本系统已经懒得再陪你扯了。自己回去悟。",
          ended: true,
          options: []
        }
      });
    }

    const historyText = buildChatHistoryText(history);

    const systemPrompt = getAiBasePrompt("chat");

    const userPrompt = `
玩家信息：
姓名：${playerInfo.name}
境界：${playerInfo.realmName}${playerInfo.subRealmName}
系统道路：${pathName}
当前地图：${mapInfo.mapName}
当前区域：${mapInfo.zoneName}

最近对话：
${historyText || "暂无"}

玩家这次回复：
${choice || "召唤系统"}

已回复轮数：${aiReplyCount}
最多 10 轮后结束对话。

请继续对话，保持上下文相关，并且继续给出三个回复选项。
`;

    const data = await callAiChatCompletion(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      0.75
    );

    const content = data.choices?.[0]?.message?.content || "";
    const parsed = extractJsonFromText(content);

    if (!parsed) {
      return res.status(500).json({
        ok: false,
        message: "AI 聊天返回格式错误",
        raw: content
      });
    }

    const ended = !!parsed.ended || aiReplyCount >= 9;
    let options = Array.isArray(parsed.options) ? parsed.options.slice(0, 3) : [];

    if (!ended) {
      while (options.length < 3) {
        options.push(["本座受教了", "你少瞧不起人", "那下一步怎么修"][options.length]);
      }
    } else {
      options = [];
    }

    res.json({
      ok: true,
      result: {
        dialogue: sanitizeLongText(parsed.dialogue || "本系统懒得解释第二遍。", 160),
        ended,
        options: options.map(item => sanitizeText(item, 24))
      }
    });
  } catch (error) {
    console.error("ai system-chat error:", error);
    res.status(500).json({
      ok: false,
      message: error.message || "AI 聊天服务异常"
    });
  }
});

function getWsTokenFromReq(req) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    return url.searchParams.get("token") || "";
  } catch {
    return "";
  }
}

wss.on("connection", (ws, req) => {
  const token = getWsTokenFromReq(req);
  const account = getAccountByToken(token);

  if (!account) {
    sendWs(ws, {
      type: "auth_error",
      message: "WebSocket 未登录或登录已过期"
    });
    try { ws.close(); } catch {}
    return;
  }

  if (isAccountBanned(account)) {
    sendWs(ws, {
      type: "auth_error",
      message: "账号已被封禁"
    });
    try { ws.close(); } catch {}
    return;
  }
  onlineClients.set(account, {
    ws,
    account,
    connectedAt: Date.now(),
    lastPongAt: Date.now()
  });

  sendWs(ws, {
    type: "connected",
    account,
    message: "已连接实时服务器",
    time: Date.now()
  });

  sendWs(ws, {
    type: "world_chat_history",
    messages: worldChatMessages
  });

  broadcast({
    type: "system_notice",
    level: "info",
    message: `${account} 道友上线了`,
    time: Date.now()
  });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      sendWs(ws, {
        type: "error",
        message: "WebSocket 消息格式错误"
      });
      return;
    }

    if (data.type === "ping") {
      const client = onlineClients.get(account);
      if (client) client.lastPongAt = Date.now();

      sendWs(ws, {
        type: "pong",
        serverTime: Date.now()
      });
      return;
    }

    if (data.type === "world_chat") {
      if (isAccountMuted(account)) {
        const remainMs = Math.max(0, getMuteUntil(account) - Date.now());
        const remainMinutes = Math.max(1, Math.ceil(remainMs / 60000));

        sendWs(ws, {
          type: "error",
          message: `你已被禁言，剩余约 ${remainMinutes} 分钟`
        });
        return;
      }
      const text = sanitizeText(data.text || "", 80);
      if (!text) {
        sendWs(ws, {
          type: "error",
          message: "聊天内容不能为空"
        });
        return;
      }

      const message = {
        id: uid("chat"),
        type: "world_chat_message",
        channel: "world",
        account,
        name: sanitizeText(data.name || account, 12),
        realm: sanitizeText(data.realm || "未知境界", 20),
        text,
        time: Date.now()
      };

      worldChatMessages.push(message);
      while (worldChatMessages.length > WORLD_CHAT_LIMIT) {
        worldChatMessages.shift();
      }

      saveWorldChat().catch(err => console.warn("保存世界聊天失败：", err));
      broadcast(message);
      return;
    }

    if (data.type === "client_notice") {
      broadcast({
        type: "system_notice",
        level: sanitizeText(data.level || "info", 12),
        from: account,
        message: sanitizeText(data.message || "有道友触发了系统事件", 80),
        time: Date.now()
      });
      return;
    }

    if (data.type === "save_patch") {
      sendWs(ws, {
        type: "save_hint",
        message: "当前版本仍以 HTTP 存档为准",
        seq: data.seq || null,
        time: Date.now()
      });
      return;
    }

    sendWs(ws, {
      type: "error",
      message: "未知 WebSocket 消息类型：" + data.type
    });
  });

  ws.on("close", () => {
    onlineClients.delete(account);

    broadcast({
      type: "system_notice",
      level: "info",
      message: `${account} 道友已离线`,
      time: Date.now()
    });
  });

  ws.on("error", () => {
    onlineClients.delete(account);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [account, client] of onlineClients.entries()) {
    if (now - client.lastPongAt > 60000) {
      try {
        client.ws.close();
      } catch {}
      onlineClients.delete(account);
    }
  }
}, 30000);

app.use(express.static(PUBLIC_DIR));

app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

setInterval(() => {
  settleExpiredTrades().catch(error => {
    console.warn("自动结算交易行失败：", error);
  });
}, 30000);
server.listen(PORT, () => {
  console.log(`《转世之修仙系统》服务器已启动：http://0.0.0.0:${PORT}`);
  console.log(`AI：${AI_API_KEY ? "已配置" : "未配置"}`);
});