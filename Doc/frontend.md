# Time in the Bottle — 前端设计规范

> 本文件定义前端**视觉语言、组件规格和交互行为**，是 Claude Design 原型的工程化落地文档。
> 产品玩法见 `game-design.md`，系统架构见 `architecture.md`。

---

## 设计原则

- **单一字族、单一强调色**：等宽字（JetBrains Mono）+ 琥珀色，避免视觉噪音
- **暖中性灰**：所有白/黑带暖调，低饱和，避免廉价感
- **数据即装饰**：排行、计数、颗粒数是画面的全部信息密度，不堆砌多余图标
- **像素美学**：沙井刻意保留 4px 颗粒，与等宽字呼应，统一"低分辨率仪器"语言

---

## 色彩系统

### CSS 变量（根级）

```css
:root {
  /* 工作台 / 界面 */
  --color-workbench:     #e7e5df;   /* 最外层背景 */
  --color-card:          #faf9f6;   /* 主容器纸面 */
  --color-card-border:   #e0ded6;   /* 1px 卡片描边 */
  --color-text-primary:  #1c1c1e;   /* 标题、用户名 */
  --color-text-secondary:#55534c;   /* 计数 */
  --color-text-weak:     #8a887e;   /* 副标题、提示 */
  --color-label:         #a09e94;   /* 全大写小标签 */
  --color-label-alt:     #b3b1a7;
  --color-divider:       #ecebe4;   /* 浅分隔 */
  --color-progress-bg:   #f2f1ea;   /* 进度条背景槽 */

  /* 沙井（canvas 内部） */
  --color-well-bg:       #161619;
  --color-well-border:   #2a2a2f;
  --color-scrollbar-track: rgba(255,255,255,.06);
  --color-scrollbar-thumb: rgba(255,255,255,.28);
  --color-surface-btn:   #e0a24e;   /* "back to surface" 琥珀按钮 */

  /* 玩家身份色（沙粒 + 排行）——房间最多4人，颜色是客观属性，所有客户端渲染一致，不存在"你"这个特殊身份 */
  --color-player-1:      #e0a24e;   /* 琥珀 */
  --color-player-2:      #46b6a6;   /* 青 */
  --color-player-3:      #9c82dd;   /* 紫 */
  --color-player-4:      #de6e92;   /* 玫红 */

  /* 通用强调（光标、live 点） */
  --color-accent:        #e0a24e;
}
```

### 说明

- 四个玩家色共享相近明度与彩度，仅色相区分身份；颜色与 `playerID` 在服务端绑定，由加入顺序/默认分配决定，对所有客户端一致——不存在"我固定是某个颜色"的特殊情况
- "本机是哪一个"通过描边/标记区分，不通过颜色本身区分（颜色是客观身份属性，不能用来表达"谁在看"，否则不同客户端会渲染出不一致的画面）
- ⚠️ 待定：`--color-player-1` 与 `--color-accent` 当前是同一个琥珀色，原本是因为"你=琥珀=强调色"三者重合而选的；现在玩家颜色客观化之后，玩家1恰好用了琥珀，可能会和纯 UI 强调色（live 点、按钮）混淆，要不要换一个颜色还需要再定
- 严禁使用纯白 `#ffffff` 或纯黑 `#000000`

---

## 字体规范

```css
font-family: 'JetBrains Mono', ui-monospace, monospace;
```

| 用途 | size | weight | letter-spacing | transform |
|---|---|---|---|---|
| 主标题 | 12px | 700 | 0.22em | uppercase |
| 副标题 | 11.5px | 400 | — | — |
| 小节标签 | 10.5px | 500 | 0.18em | uppercase |
| 用户名 / 正文 | 12–12.5px | 500 | — | — |
| 排行计数 | 12px | 700 | — | — |
| 底部脚注 | 10px | 400 | 0.1em | uppercase |

- 数字一律右对齐，设置最小宽度防跳动
- 等宽字族强化"仪器 / 数据"气质，不得替换为衬线或无衬线字体

---

## 布局结构

```
┌─ 工作台 #e7e5df ────────────────────────────────┐
│  ┌─ 卡片 #faf9f6 ─────────────────────────────┐ │
│  │  Header：标题 / 副标题           ● live     │ │
│  │  ┌──────────────┐  ┌─────────────────────┐  │ │
│  │  │              │  │  who's pouring       │  │ │
│  │  │  THE BOTTLE  │  │   ▸ 用户排行条 ×4    │  │ │
│  │  │  (canvas)    │  │   ▸ grains recorded  │  │ │
│  │  │  360 × 560   │  │   ▸ 提示卡 / 重置    │  │ │
│  │  │       ▕滚动条 │  │                     │  │ │
│  │  └──────────────┘  └─────────────────────┘  │ │
│  │  the bottle · drag down to dig   N keystrokes│ │
│  └─────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

### 关键尺寸

| 元素 | 规格 |
|---|---|
| 卡片内边距 | `26px 28px 24px` |
| 卡片圆角 | `6px` |
| 瓶子 canvas | `360 × 560px`，圆角 `3px`，`image-rendering: pixelated` |
| 右栏宽度 | `272px` |
| 主体两栏间距 | `28px` |
| 卡片内纵向 gap | `20px` |

---

## 组件规格

### Header

- 左：主标题（`TIME IN THE BOTTLE`）+ 副标题（`digital labor, one keystroke at a time`）
- 右：`● live` 状态——6px 圆点，颜色 `--color-player-2`（青），`blink` 动画 2.4s 循环

### 瓶子（canvas）

- 背景色：`--color-well-bg`，`image-rendering: pixelated`，4px 像素颗粒
- 右侧贴 4px 自定义滚动条：轨 `--color-scrollbar-track`，滑块 `--color-scrollbar-thumb`
- 拖拽行为：鼠标按下拖动 = 挖掘；光标 `grab` → `grabbing`
- 浏览历史时：顶部浮出琥珀色 `↑ back to surface` 胶囊按钮（`--color-surface-btn`）
- 下方脚注：左 `the bottle · drag down to dig`，右 `N keystrokes`

### 用户排行栏（who's pouring）

- 每行：身份色块（9px 圆角方）+ 用户名 + 角色标签 + 计数 + 进度条
- "本机"所在行：用描边或角标标记（如 "·本机" 小标签），不用背景色填充——背景色填充容易和某个玩家恰好分到的身份色混淆（如玩家1是琥珀时，琥珀背景会让人以为玩家1就是"你"）
- 进度条：宽度 = `count / max`，`transition: width .3s ease`

### 信息区

- `N grains recorded below`：浅色信息条，提示已沉积颗粒数
- 提示卡（深色）：`type anywhere to pour amber▮`，琥珀光标 `blink` 动画 1.1s
- `empty the bottle`：幽灵按钮（透明底 + `--color-card-border` 描边），hover 变 `--color-divider` 底

---

## 动效规范

| 动画名 | 用途 | 规格 |
|---|---|---|
| `blink` (live 点) | Header 状态指示 | 2.4s，opacity 0.2 → 1 循环 |
| `blink` (光标) | 提示卡文本光标 | 1.1s，steps(1) 闪烁 |
| 进度条宽度 | 排行变化 | `width .3s ease` |
| 摄像机跟随 | 回到表面 / 沉降补偿 | 指数趋近：`cameraY += (target - cameraY) * 0.16` |
| 沙粒物理 | 每帧重力下落 | 见沙粒系统技术规格 |

---

## 沙粒系统技术规格

> ⚠️ 2026-06-21 转向后：这套**物理 / 网格规格搬到服务端**（权威模拟），客户端只按收到的网格渲染。下表参数（W / S / 活跃高 / 颜色映射 / 出口布局）作为**服务端模拟 + 客户端渲染共享的约定**仍然有效；`FREEZE_AT` / `BAND` 等"冻结"概念在服务端权威下另行审视（见 `architecture.md`）。
>
> 驱动 canvas 内全部视觉的核心模块。

| 参数 | 值 | 说明 |
|---|---|---|
| 网格宽 W | 90 列 | |
| 活跃模拟区高 | 200 行 | |
| 像素格大小 S | 4px | 渲染时每格 = 4×4 像素 |
| 可视行数 | 140 行 | = 560px |
| `FREEZE_AT` | 40 行 | 沙堆峰值超此值触发冻结 |
| `BAND` | 16 行 | 底部冻结带高度 |
| 冻结触发条件 | `BAND` 填充率 > 50% | |
| `HEADROOM` | 36 行 | 摄像机跟随时保留的空气行数 |

**重力算法：**

```
逐行自底向上扫描，每格：
  1. 优先下落（下方空）
  2. 否则随机左下 / 右下滑落
扫描方向逐帧左右交替，避免偏移
```

**颜色映射：**

```
网格值 0 = 空
网格值 1 = --color-player-1
网格值 2 = --color-player-2
网格值 3 = --color-player-3
网格值 4 = --color-player-4
```

玩家与网格值的映射由服务端 `players` 里的顺序/分配决定，所有客户端拿到的映射一致，不存在"我固定是某个值"的特殊情况。

**多人出口布局：**

房间最多 4 人，地位完全对等，出口位置（沙粒从瓶口何处开始下落）按在线人数居中对称排列：

| 在线人数 | 出口位置 |
|---|---|
| 1 | 正中央 |
| 2 | 居中对称两点，留出间距 |
| 3 | 居中对称三等分 |
| 4 | 居中对称四等分 |

- 出口位置只决定"新沙粒从哪开始落下"，不影响已经沉积/冻结的历史像素——历史地层一旦冻结即永久保留原状，不随人数变化重新排列
- 人数变化（加入/离开）只重新计算出口位置，不触发任何已沉积沙粒的位置变化
- 具体列号需按上表比例换算到 90 列网格（`W`），实现时再定

**渲染管线：**

1. 可视世界行 → `90×142` 离屏 `ImageData`（`Uint32` 直写像素）
2. `drawImage` 放大 4× 到主 canvas
3. `-frac * S` 实现亚像素平滑滚动