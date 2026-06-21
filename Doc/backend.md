# Time in the Bottle — 后端规范

> 本文件定义 **Cloudflare Workers + Durable Objects 后端的协议、结构和部署方式**。
> 系统架构背景见 `architecture.md`。

---

## 架构

```
[GitHub Pages UI]  ←→  WebSocket(wss)  ←→  [Worker] → [Durable Object: 一个房间]
                                            /parties/main/{roomId}?_pk={playerId}
```

Worker 按 `roomId` 把连接路由到对应 DO（`idFromName(roomId)`）。

后端有两个职责：

1. **实时转发**：收到某玩家的 ticks，广播给同房间所有人——仍然不运行物理模拟，只传递整数
2. **房间持久化**：客户端本地沙堆触发冻结时，把该地层的像素快照上报；DO 把快照和玩家档案写入 storage 持久化；新玩家加入/老玩家重连时，立即把房间当前快照下发，不需要让客户端重放历史

服务端依然不理解快照内容（不解析像素语义），只负责存和发——这点和最初的设计保持一致，只是多了"存"这一步。

---

## 消息协议

### 客户端 → 服务端

```ts
{ type: "join",     name: "Fay", color: "auto" }   // 加入房间；color 当前固定传 "auto"，预留未来手动选色
{ type: "progress", ticks: 42 }                      // 定时上报击键累计数
{ type: "freeze",   band: <像素快照> }                // 本地触发冻结时上报该地层；服务端不解析内容，原样存储转发
```

### 服务端 → 客户端（广播）

```ts
{
  type: "state",
  players: {
    "player-uuid-abc": { name: "Fay",  color: "amber", ticks: 42 },
    "player-uuid-xyz": { name: "Mina", color: "teal",  ticks: 67 }
  },
  frozenBands: [ /* 已冻结地层快照数组，按冻结顺序排列，只追加不可变 */ ]
}
```

```ts
{ type: "error", reason: "room_full" }   // 房间已满4人时，拒绝新玩家（已在房间内的人重连不受影响）
```

---

## 节流（客户端负责）

```js
const TICK_INTERVAL_MS = 100; // 唯一需要调整的节流参数，10fps

let pendingTicks = null;

function onTick(currentTicks) {
  pendingTicks = currentTicks; // 只保留最新值
}

setInterval(() => {
  if (pendingTicks !== null && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "progress", ticks: pendingTicks }));
    pendingTicks = null;
  }
}, TICK_INTERVAL_MS);
```

服务端收到什么就广播什么，不做额外节流。

---

## 服务端结构（`party/server.ts`）

> ℹ️ `RaceRoom` 类名 / `project-bar` worker 名沿用自旧版本（Project Bar 赛车主题），语义已不符，但**决定保留不改**：worker 已部署且 `index.html` 的 `PROD_HOST` 指向它，类名对玩家不可见（只用房间码），重命名只会孤儿化线上 worker、改 URL、还要为 DO 类重命名做 migration——无用户侧收益。

```ts
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/parties\/main\/([^/]+)/);
    if (request.headers.get("Upgrade") === "websocket" && m) {
      const stub = env.RACEROOM.get(
        env.RACEROOM.idFromName(decodeURIComponent(m[1]))
      );
      return stub.fetch(request);
    }
    return new Response("Time in the Bottle room server");
  },
};

export class RaceRoom {          // 类名保留(见上方说明),勿改
  players = {};                  // playerId → { name, color, ticks }（持久化于 storage，断线不删除）
  frozenBands = [];              // 已冻结地层快照（持久化于 storage，只追加，不可变）
  conns = new Map();             // WebSocket → playerId（仅用于路由，断线后从这里移除）

  // DO 激活时需先从 state.storage 把 players / frozenBands 读回内存，
  // 因为 DO 闲置一段时间会被回收，内存字段会丢失，storage 里的才是真正权威的数据

  async fetch(request) {
    const playerId =
      new URL(request.url).searchParams.get("_pk") || crypto.randomUUID();
    const isNewPlayer = !this.players[playerId];
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    if (isNewPlayer && Object.keys(this.players).length >= 4) {
      // 先 accept 再发 error 再 close:浏览器 WebSocket 读不到 HTTP 403 的响应体,
      // 只能通过已建立的 WS 通道把 room_full 原因送达客户端,然后主动关闭。
      server.send(JSON.stringify({ type: "error", reason: "room_full" }));
      server.close(4001, "room_full");
      return new Response(null, { status: 101, webSocket: client });
    }
    this.conns.set(server, playerId);
    server.send(JSON.stringify({
      type: "state",
      players: this.players,
      frozenBands: this.frozenBands,   // 完整快照，新玩家/重连直接渲染，不重放
    }));
    server.addEventListener("message", (e) => this.onMessage(playerId, e.data));
    const drop = () => this.onClose(server);
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);
    return new Response(null, { status: 101, webSocket: client });
  }
  // onMessage:
  //   join     → 建档（首次）或恢复在线标记（已存在的 playerId）；写 storage；broadcast()
  //   progress → 更新该 playerId 的 ticks；broadcast()
  //   freeze   → 把上报的地层快照 push 进 frozenBands；写 storage；广播给除发送者外的所有人
  //   坏/未知消息忽略
  // onClose: 只从 conns 移除对应连接；players 数据保留——房间持久化，离线不等于退出
  // broadcast: 向 conns 里所有 socket 发 { type:"state", players, frozenBands }
}
```

---

## 配置（`wrangler.toml`）

```toml
name = "project-bar"   # 保留已部署的 worker 名(见上方"类名保留"说明)
main = "party/server.ts"
compatibility_date = "2026-06-18"

[[durable_objects.bindings]]
name = "RACEROOM"
class_name = "RaceRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RaceRoom"]   # SQLite 版 DO = 免费套餐可用
```

---

## 前端接入要点

- **自带持久 playerId**：用 `?_pk=<playerId>` 连接，`playerId` 需要存进 `localStorage`（如 `localStorage['titb.playerId']`）并复用，**不是每次连接都重新生成**——这样断线重连、关掉应用重开，服务端才能认出"还是同一个人"，而不是把你当成新玩家占掉一个名额
- **房间容量上限 4 人**：服务端拒绝第 5 个新 `playerId` 的连接（已在房间内的人重连不受影响，靠 `playerId` 匹配判断是否是"老玩家回来了"还是"新玩家想进来"）
- **本地出沙零延迟**：自己的沙粒由本地 `keycount` 事件即时驱动；只有**别人的**出沙速率从广播 `state` 获取
- **冻结快照上报**：本地沙堆触发冻结时，把该地层快照通过 `{ type:"freeze", band }` 上报，服务端存档并广播给其他在线玩家。这是房间"沉积持久化"的全部内容——活跃区域（未冻结部分）不需要做快照同步，本来就允许各端画面不完全一致
- **房间码**：4 位易读码（去掉 I L O 0 1），存 `localStorage['titb.room']`；菜单「新建 / 加入 / 复制链接」——对应两种入口：不带房间号默认新建房间，带房间号或邀请链接则加入已有房间
- **昵称**：`localStorage['titb.name']`，默认 `玩家-<id前4>`，菜单可改，改后自动重连
- **主机解析**：`file://` / `localhost` / `127.0.0.1` → `ws://127.0.0.1:8787`（本地 wrangler dev）；否则 → `wss://<PROD_HOST>`
- **优雅退回单机**：无 `?room=` 参数且未配置 host 时静默不连，不影响单机体验

### WebSocket 连接示例

```js
const roomId  = new URLSearchParams(location.search).get("room")
             || Math.random().toString(36).slice(2, 8);

// playerId 必须持久化复用，不能每次刷新都重新生成
let myId = localStorage.getItem("titb.playerId");
if (!myId) {
  myId = crypto.randomUUID();
  localStorage.setItem("titb.playerId", myId);
}

const ws = new WebSocket(
  `${wsProto}://${PARTY_HOST}/parties/main/${roomId}?_pk=${myId}`
);

ws.onopen = () =>
  ws.send(JSON.stringify({ type: "join", name: playerName, color: "auto" }));

ws.onmessage = ({ data }) => {
  const { type, players, frozenBands, reason } = JSON.parse(data);
  if (type === "error") {
    if (reason === "room_full") showRoomFullNotice();
    return;
  }
  if (type !== "state") return;
  renderFrozenBands(frozenBands);      // 直接渲染快照，不重放
  for (const id in players) {
    if (id === myId) continue;         // 自己本地驱动，跳过
    const { name, color, ticks } = players[id];
    // 根据 ticks 设置该用户的出沙速率
    setSandRate(id, name, color, ticks);
  }
};
```

---

## 部署

```bash
# 本地联调（推荐先做，无需账号）
npm run party:dev    # = npx wrangler dev，监听 127.0.0.1:8787
# 浏览器开两个标签：.../index.html?room=TEST&sim

# 上云（异地联机）
npx wrangler login
npm run party:deploy  # 打印 time-in-the-bottle.<子域名>.workers.dev
# 把该地址填进 index.html 的 PROD_HOST
```

### 房间分享 URL 格式

```
https://<你的域名>/?room=ABCD
# Tauri 叠加层需带 #overlay：?room=ABCD#overlay
```

---

## 待决

- **中国大陆可达性**：`*.workers.dev` 常被墙，面向大陆分发时需改用海外 VPS 方案（见 `architecture.md`）
- **冻结仲裁规则（Phase B 已定方向）**：采用**序号守卫的先到先得 + 采纳**——客户端乐观本地冻结并上报它认为的 band 序号，服务端仅当序号 == 当前 `frozenBands.length` 时 CAS 追加；落败端回滚本地、采纳广播来的权威版本。保证全房间单一线性历史，代价是落败端一次视觉跳变（可接受）。具体协议字段待 Phase B 实现时补。
- **断网缓冲策略**：玩家打字时网络抖动/短暂断线，这段时间产生的 ticks 和即将触发的冻结怎么处理——直接丢弃，还是本地做一个轻量的待发送队列（不是完整存档，只是几秒到几分钟的缓冲，网络恢复后补发）
