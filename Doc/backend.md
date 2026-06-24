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
{ type:"reset" }                            // 清空本房间画布 + 归档（原型：任何人可）
{ type:"spout", size: 3 }                   // 出水口画笔大小 N×N（1..5）
{ type:"pour",  on:true }                   // debug：按当前画笔持续出沙（看效果）
{ type:"flood", on:true }                   // debug：从底部实心快速灌满（测归档）
{ type:"ping",  t: 123 }                    // 测 RTT，服务端原样回 pong
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

// ping 的回声（客户端据此算 RTT）
{ type:"pong", t: 123 }
```

- 格子值：`0`=空，`1..4`=玩家槽位（颜色）。`idx = row*W + col`。
- 增量优先：高频 tick 只发变化单元；`snapshot` 仅在加入时发一次。
- `band` 是低频事件（只在压缩触发时发一条）。收到时客户端做与服务端**完全相同**的确定性下移（`grid` 整体下移 `rows` 行、顶部腾空），再把这条带追加到归档；因为是确定性的，无需重发整张 `snapshot`，稳态几乎不占带宽。
- 客户端**不做** 1px 细条特殊显示：归档带在世界坐标里按真实高度 `rows` 展开，滚动到附近时显示成正常高度的彩色层（每列主色，有损），压缩对用户透明。相机随之 `cameraY += rows`，视图不动。

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
| 物理帧率 | 20fps（`TICK_MS=50`） | 每 tick：spawn → flood → 重力×2 子步 → diff → 广播 patch → 压缩检查（2 子步让下落更顺） |
| 出水口画笔 `DEFAULT_SPOUT` | 1（上限 `SPOUT_MAX=5`） | 出沙是以出口为锚点的 **N×N 方形画笔**：每 tick 在 footprint 内从队列补满。1=一颗一颗，≥2=连续 |
| 房间容量 | 4 人 | 第 5 个新玩家 → `room_full` |
| 存盘间隔 | 5s（`SAVE_MS`） | dirty 才写 |
| `COMPRESS_ROWS`（Stage 3） | 64 | 一次折叠的底部行数（= 一条 band 的真实行数） |
| `COMPRESS_MARGIN`（Stage 3） | 40 | 触发阈值：当**密实层** `packedTop()`（行内 ≥ W/2 的最高行）逼近顶部到这么近时归档 |
| `FLOOD_ROWS_PER_TICK` | 6 | debug `flood`：直接从底部实心填这么多行/tick（快速灌满测归档，绕过出沙/物理） |

### 出水口：N×N 方形画笔

每次击键 +1 粒入队（上限 600）。`spawn()` 把出沙做成**以出口为锚点、居中的 N×N 方形画笔**（`N=spoutSize`，1..5）：每 tick 在画笔 footprint 内把空格从队列补满。

- **为什么 N≥2 连续**：画笔 **N 行高**，重力每 tick 落 2 行，所以上下两批正好接上 → 连续 N 列宽的水流；**N=1** 则每隔一行空一格（一颗一颗的旧虚线感）。
- **吞吐自洽不会堵**：footprint 每 tick 落出底部 2 行 ≈ 2·N 粒，正好 = N 宽水流的吞吐（≤2·N/tick），所以越宽流越快、但不会在出口堆积。
- 沙的**总量**仍 = 击键数（队列），画笔只决定**宽度/最大流速**。"按频率放大流量/水龙头开关"等是后续在此之上叠加的玩法。
- debug：`{type:"pour"}` 让画笔满载持续出沙（看效果）；`{type:"spout",size}` 调画笔大小。

物理算法（逐行自底向上，重力 + 随机左右下滑，扫描方向逐帧交替）沿用旧客户端引擎，现在跑在服务端、对所有人是同一份。

> 测试用环境变量(覆盖上表，仅供 smoke 测试起小而快的房间；**生产用默认值**，`W/H` 是与客户端的共享契约)：`SAND_H` / `SAND_COMPRESS_ROWS` / `SAND_COMPRESS_MARGIN` / `SAND_SPOUT` / `SAND_SAVE_MS` / `SAND_DATA_DIR`。

---

## Stage 3：归档（无限堆积）

让瓶子能无限往上堆而不把 `H` 无限加大：**活动网格固定大小**（跑物理 + 全分辨率渲染，物理开销有上限），深层老沙**逐像素无损**搬进**归档带 `band`** 堆在活动网格下方。

- **触发**：每 tick 在广播 patch 之后检查 `packedTop() <= COMPRESS_MARGIN`（密实层逼近顶部）→ 归档。
- **归档（无损）**：把底部 `COMPRESS_ROWS` 行的**真实像素原样**拷进一条 band；`n` = 这些行的沙粒数。底部全空则跳过（不归档空带）。
- **下移**：`grid` 整体下移 `COMPRESS_ROWS` 行（`copyWithin`），顶部腾空继续接新沙；`prev` 同步为下移后网格（不发冗余大 patch），广播一条 `band`。
- **band 结构**（内存 `{ rows, n, cells:Uint8Array(rows*W) }`；线/盘 `cells` 转 base64）：`rows`=折叠了多少行，`n`=沙粒数（"已埋"计数），`cells`=那 `rows*W` 格的**精确像素**（槽位 0..4）。
- **顺序**：`bands` 数组 index 0 = 最老/最深，末尾 = 最新（紧贴活动网格底部）。客户端把归档接在活动网格下方、按真实高度逐像素渲染（与活体沙同一套着色，深度 run 跨接缝连续）→ 历史无缝、和当时一模一样。
- **隐私红线照旧**：band 只存颜色槽位 + 计数，**绝无键位内容/文本**。

> **体积优化（暂未做，第二步）**：当前 band 存原始像素未压缩（`rows*W` 字节/条），归档随历史线性增长。后续加 RLE/gzip（沉积沙极易压）把它压小；超深历史再加二级压缩。当前第一步只保证**完整无损可记录、可下滑回看**。

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
