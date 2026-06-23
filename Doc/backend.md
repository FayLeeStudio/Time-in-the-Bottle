# Sand Together — 后端规范（服务端权威）

> 2026-06-21 架构转向后的后端：**常驻 Node + ws 服务，跑权威物理**。
> 旧的 Cloudflare Workers + DO 版本已作废（见 git 历史 / `party/`）。
> 架构背景见 `architecture.md`、`CLAUDE.md`。

---

## 职责

后端是一个**常驻、有状态**的进程。对每个房间：

1. 跑 falling-sand 物理模拟（权威），持有该房间唯一的 `grid`（= 房间真相）
2. 收客户端输入（累计击键数 `ticks`），换算成出沙
3. 把 `grid` 的**增量变化**广播给同房间所有客户端
4. 把 `grid` + 玩家档案**持久化到磁盘**（存档），重启 / 新人加入时恢复 / 下发

客户端**不跑物理**：只发输入、收状态、纯渲染。隐私红线：只处理计数 + 网格像素，**绝不**键位内容。

---

## 路由

```text
ws://<host>/r/<roomId>?_pk=<playerId>
```

- 每个 `roomId` 对应一个内存中的 `Room`（含 grid + 模拟循环）。
- `_pk` = 客户端**持久** playerId（存 localStorage 复用），用于认出"老玩家回来了" vs "新玩家"。
- 默认端口 `8090`（`PORT` 环境变量可改）。生产经 Caddy 反代为 `wss://<domain>`。

---

## 消息协议

### 客户端 → 服务端

```ts
{ type:"join",  name:"Fay", color:"auto" }  // 加入；color 由服务端分配
{ type:"input", ticks: 1234 }               // 累计击键数（服务端算增量 → 出沙）
{ type:"leave" }                            // 显式退出（释放颜色名额）
{ type:"reset" }                            // 清空本房间画布（原型：任何人可）
```

### 服务端 → 客户端

```ts
// 加入时：完整状态（含归档带 bands，见 Stage 3）
{ type:"snapshot", w:80, h:300,
  players:{ "<id>":{ name, color, ticks }, ... },
  grid:"<base64 of W*H bytes>",
  bands:[ { rows, n, cols:"<base64 W bytes>" }, ... ] }

// 每 tick：变化的网格单元（扁平 [格子下标, 新值, 格子下标, 新值, ...]）
{ type:"patch", c:[ idx0,val0, idx1,val1, ... ] }

// Stage 3：新生成一条归档带（活动网格刚把底部 rows 行压缩归档、整体下移 rows 行）
{ type:"band", rows, n, cols:"<base64 W bytes>" }

// 玩家名册变化（join / leave）
{ type:"players", players:{ "<id>":{ name, color, ticks }, ... } }

// 房间已满（第 5 个新玩家）
{ type:"error", reason:"room_full" }
```

- 格子值：`0`=空，`1..4`=玩家槽位（颜色）。`idx = row*W + col`。
- 增量优先：高频 tick 只发变化单元；`snapshot` 仅在加入时发一次。
- `band` 是低频事件（只在压缩触发时发一条）。收到时客户端做与服务端**完全相同**的确定性下移（`grid` 整体下移 `rows` 行、顶部腾空），再把这条带追加到归档；因为是确定性的，无需重发整张 `snapshot`，稳态几乎不占带宽。

---

## 服务端状态结构（`server/index.js`）

每个 `Room`：

```text
grid    : Uint8Array(W*H)   // 唯一真相
prev    : Uint8Array(W*H)   // 上一帧广播态，用于 diff 出 patch
players : { playerId: { name, color, ticks } }   // 持久（断线不删）
queues  : { playerId: 待出沙粒数 }
conns   : Map<ws, playerId>
```

- 进程重启 / 房间首次激活 → 从 `server/data/<roomId>.json` 读回 `players` + `grid`。
- 断线（close）：只移除连接，**保留玩家**（离线 ≠ 退出）；房间空闲时停模拟循环省 CPU，grid 留在内存 + 磁盘。
- 显式 `leave` 才删玩家、释放颜色。

---

## 模拟 / 渲染参数（服务端权威，客户端渲染共享同一约定）

| 参数 | 值 | 说明 |
|---|---|---|
| 活动网格 `W × H` | 80 × 300 | 服务端持有；客户端显示其中一个窗口（viewRows=250）。底部老沙超阈值时压缩归档（见 Stage 3），而非把 H 无限加大 |
| 颜色槽位 | amber/teal/violet/rose = 1/2/3/4 | `color 名 → grid 值`，全局一致 |
| 出口 `SPOUT_X` | {1:30,2:50,3:10,4:70} | 按槽位、沿 `W=80` 均匀分布（中心向外）；出口随堆顶上移（`surface - SPAWN_GAP`） |
| `SPAWN_GAP` | 135 | 出沙口在堆顶上方这么多行；与客户端 0.618 镜头锚点配套，使水龙头落在视口顶部附近 |
| 物理帧率 | 20fps（`TICK_MS=50`） | 每 tick：spawn → 重力×2 子步 → diff → 广播 patch → 压缩检查（2 子步让下落更顺） |
| `MAX_SPAWN_PER_TICK` | 4 / 玩家 | 限速，避免狂打字一帧倒满 |
| 房间容量 | 4 人 | 第 5 个新玩家 → `room_full` |
| 存盘间隔 | 5s（`SAVE_MS`） | dirty 才写 |
| `COMPRESS_ROWS`（Stage 3） | 64 | 一次压缩折叠的底部行数（= 一条 band 概括的真实行数） |
| `COMPRESS_MARGIN`（Stage 3） | 40 | 触发阈值：当**密实层**（行内 ≥ W/2 格的最高行 `packedTop()`）逼近顶部到这么近时压缩。用密实层而非 `surface()`，正在下落的稀疏沙幕不会误触发 |

物理算法（逐行自底向上，重力 + 随机左右下滑，扫描方向逐帧交替）沿用旧客户端引擎，现在跑在服务端、对所有人是同一份。

> 测试用：`SAND_H` / `SAND_COMPRESS_ROWS` / `SAND_COMPRESS_MARGIN` / `SAND_MAX_SPAWN` / `SAND_SAVE_MS` / `SAND_DATA_DIR` 这些环境变量可覆盖上表，仅供 `server/smoke-bands.mjs` 起一个小而快的房间；**生产必须用默认值**（`W/H` 是与客户端的共享契约）。

---

## Stage 3：压缩归档（无限堆积）

让瓶子能无限往上堆而不把 `H` 无限加大：**活动网格固定大小**（跑物理 + 全分辨率渲染），深层老沙压缩成薄层**归档带 `band`** 堆在活动网格下方。

- **触发**：每 tick 在广播 patch 之后检查 `packedTop() <= COMPRESS_MARGIN`（密实层逼近顶部）→ 压缩。
- **压缩**：取底部 `COMPRESS_ROWS` 行，每列折算成**主色**（该列在这些行里出现最多的非零槽位）；整体 `n` = 这些行的沙粒总数。底部为空则跳过（不归档空带）。
- **下移**：`grid` 整体下移 `COMPRESS_ROWS` 行（`copyWithin`），顶部腾空继续接新沙；`prev` 同步为下移后网格（不发冗余大 patch），广播一条 `band`。
- **band 结构**（内存 `{ rows, n, cols:Uint8Array(W) }`；线/盘 `cols` 转 base64）：`rows`=概括了多少行，`n`=沙粒数（用于"已埋"计数），`cols`=每列主色（W 字节，槽位 0..4）。
- **顺序**：`bands` 数组 index 0 = 最老/最深，末尾 = 最新（紧贴活动网格底部）。
- **隐私红线照旧**：band 只存每列颜色槽位 + 计数，**绝无键位内容/文本**。

> 二期（暂未实现）：向下滚动到某条 band 时**展开**还原细节；压缩条叠太高时再加二级压缩。

---

## 持久化

- 每房间一个文件 `server/data/<roomId>.json`：`{ players, grid:<base64>, bands:[{rows,n,cols}] }`（gitignored）。
- 写：dirty 时每 5s 一次 + 房间空闲停机前。读：房间首次激活时。
- 向后兼容：老存档没有 `bands` 字段 → 视为 `[]`。
- 服务端就是存档的唯一真相；新玩家加入直接收 `snapshot`（含 `bands`），不重放。

---

## 部署（海外 VPS + Caddy）

一键脚本 `server/deploy.sh`，反代配置 `server/Caddyfile`。流程：

1. 海外节点 VPS（腾讯云 / 阿里云 香港或新加坡轻量，2C2G）；域名一条 A 记录指向它（如 `titb.indiegames.design`）。
2. 把仓库弄上去：`git clone <repo>`（推荐，脚本经 `.gitattributes` 保 LF）**或** `scp` 整个仓库；`npm install --omit=dev`。
3. `sudo server/deploy.sh <domain>`：装 Node、配 systemd（常驻 + 崩溃重启）、装 Caddy（自动 Let's Encrypt 证书 + 反代 `443 → 127.0.0.1:8090`，WebSocket 透传）。
4. 云控制台安全组放行 `443`（+ `22`）。
5. 客户端 `index.html` 的 `PROD_HOST` 改为该域名（`wss`），再 push 到 Pages。

> ⚠️ **部署顺序**：先让 VPS 跑起来、本地用 `?host=<domain>` 验证 `wss` 通，**再**改 `PROD_HOST` 并 push 前端。否则线上 Pages 会指向一个还不存在的后端（空瓶 / 连不上）。

本地开发：`npm run server`（localhost:8090），`index.html` 从 `file://` / localhost 自动连本地。

---

## 待决

- **带宽优化**：`patch` 现为全 grid diff；高频多人时可进一步压（RLE / 只发活跃前沿）。
- **防作弊**：`input` 信任客户端自报计数（原型）；后期可服务端校验速率。
- **无限累积**：✅ 已实现（Stage 3 压缩归档，见上）。剩余：`bands` 无上限增长，超深历史可加二级压缩；展开某条 band 的交互（二期）。
- **多房间扩展**：单进程多房间；规模大需多进程 / 多机 + 房间路由。
