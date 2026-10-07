# dsh-session-chime

会话**真正停下**时响一声。

一个 DSH（DeepSeek Harness）插件：监听这个实例里所有在工作的顶层会话，在"主 agent 完全停止"时用铃声提醒你——没有运行中的回合、没有它自己的后台作业在跑、也没有在工作中的子代理。目标进入 **blocked（受阻）** 也算一次停下，可以单独配一个铃声。

- 铃声、音量、播放时长、安静判定都在**插件设置页**里改，保存即生效，不需要重启。
- 铃声是随插件打包的 **CC0** 音效（Kenney Interface Sounds），离线可用，没有外部请求。
- 声音在**浏览器里**播放：页面开着（后台标签页也行）就能响，页面关掉就不响——这是刻意的。

## 为什么"停下"不是"回合结束"

只监听"回合结束"会在这些情况下误报：

| 情况 | 回合状态 | 应该响吗 |
|---|---|---|
| 主 agent 在等自己起的后台作业 | 回合已结束、会话 idle | ❌ 还在工作 |
| 主 agent 在等在工作的子代理 | 同上 | ❌ 还在工作 |
| 目标仍然 active（比如闸门正持有续行） | idle | ❌ 还会继续 |
| 目标 blocked（受阻） | idle | ✅ 用"受阻"铃声 |
| 无目标、无后台、无子代理 | idle | ✅ 用"完成"铃声 |

所以判定是四路信号叠加：会话 `running`、该会话**自己拥有的**存活作业、在工作的直接子代理、目标投影的 `phase`。任何一路说明还在工作就不响。

## 安装

未发布到 npm，从 GitHub Release 的 tarball 或仓库检出安装：

```bash
# 在 profile 里
dsh profile install https://github.com/LMGateX/dsh-session-chime/releases/download/v0.1.0/dsh-session-chime-0.1.0.tgz
```

装好后在 **插件 → 会话铃声 → 点组件行 `session-chime`** 打开设置表单。

## 设置页

插件页里的表单分成三组，各用一条品牌色竖线标出组名，控件用主题色（主按钮是实心品牌色、试听按钮是描边品牌色、滑块与开关用 accent 色），卡片背景走 `--dsw-alias-bg-layer-2`，深浅色主题都跟着 DSH 自己的 token：

| 分组 | 字段 |
|---|---|
| 提示音 | 启用铃声、完成提示音、受阻提示音、音量（滑块）、播放时长、安静判定 |
| 安静规则 | 勿扰/休息时怎么响、短响时长、勿扰时段开始/结束（时间选择器）、休息模式 |
| 停止与提示卡 | 最短响铃、显示停止卡片、卡片位置 |

文案**跟随界面语言**：通过公开的 `ctx.locale` 服务把每条标签/说明解析成当前语言（内置中文与英文），locale 切换会即时重绘；面板标题与描述来自 `locale/zh.json` / `locale/en.json`。宿主 schema 里的描述同样中英双语（生成表单会原样打印）。

响铃卡片也会按原因着色：完成是绿色（`--dsw-alias-state-success-primary`）、受阻是琥珀色（`--dsw-alias-state-warn-primary`），停止按钮用实心品牌色。

## 设置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关掉后没有任何提示音，行与设置都保留 |
| `soundDone` | `chime-soft` | 完成铃声，6 个可选 |
| `soundBlocked` | `alert-low` | 受阻铃声，6 个可选 |
| `volume` | `0.8` | 音量 0–1 |
| `durationMs` | `0` | 播放时长上限；0＝完整播一次，正数＝最多响这么久（短铃声按间隔重复到时长用完，**上限 6 小时**） |
| `debounceMs` | `1500` | 安静判定：停下后要安静这么久才算结束，用来躲开回合间隙 |
| `quietStyle` | `short` | 勿扰/休息时怎么响：`short` 短响、`silent` 不响 |
| `quietShortMs` | `600` | 安静期间"短响"的时长 |
| `dndStart` | 空 | 勿扰时段开始（本地时间 `HH:mm`），留空＝不启用 |
| `dndEnd` | 空 | 勿扰时段结束；结束早于开始表示跨午夜（`22:00`→`08:00`） |
| `restMode` | `false` | 休息模式：一直按上面的安静规则处理 |
| `minRingMs` | `3000` | 最短响铃：在这之前鼠标/键盘活动不会打断；卡片按钮不受限制 |
| `banner` | `true` | 响铃时弹出停止卡片（写清哪个会话、带"停止铃声"按钮） |
| `bannerPlacement` | `bottom-center` | 卡片位置：4 个角落 / 居中 / 居中+遮罩（`modal`） |

六个铃声（全部 CC0，来自 Kenney "Interface Sounds"）：`chime-soft` 柔和双音、`bell-bright` 清脆铃、`marimba` 木琴上行、`alert-low` 低沉警示、`alert-sharp` 短促警示、`blip` 轻点。设置页里点击 **试听完成音** 可以直接听。

## 安静规则与休息模式

两种"现在别吵我"的来源，规则一样（由 `quietStyle` 决定）：

- **勿扰时段**：`dndStart`–`dndEnd`，本地时间 `HH:mm`，可以跨午夜（`22:00` → `08:00`）。留空、或开始与结束相同＝不启用。判定用**浏览器所在机器的本地时间**，因为声音是它放的。
- **休息模式**：一键开关，等价于"一直处于勿扰时段"。设置页里有复选框，**侧边栏底部也有一枚 🌙/🔔 按钮**（工作 ⇄ 休息），点一下就写入配置、立即生效。

安静期间 `short`＝只响 `quietShortMs`（默认 600ms），`silent`＝完全不响。

## 响铃时怎么停

`durationMs` 可以设到 6 小时——短铃声会按 ~120ms 间隔重复到时长用完。这么长的响铃有三条停下来的路：

1. **卡片上的"停止铃声"按钮**（显式停止，**不受最短响铃限制，点下去立刻停**）。响铃时界面下方会浮出一张卡片：

   ```
   🔔 会话已完成
   修复登录
   铃声会响到 60 秒用完；响够 3 秒后，点一下页面或按任意键也会停。
                                    [ 停止铃声 ]
   ```

   它注册在公开 slot `shell.overlay`（list 型、叠加式、不替换自带项）；这一层本身点击穿透，只有卡片自己接管指针事件，所以不会挡住底下的操作。可以用 `banner` 关掉整张卡片。

   **位置可选**（`bannerPlacement`）：`bottom-center`（默认）、`bottom-right`、`bottom-left`、`top-right`、`top-left`、`center`、`modal`。默认给底部居中的理由很实际——**角落经常已经被别的 UI 插件占了**，强制角落迟早撞车，所以这里是一组可选值而不是写死一个位置。

   **`modal` 是"必须确认"模式**：居中弹窗 + 半透明遮罩，遮罩吞掉整个界面的指针事件，**只有"停止铃声"按钮能让它消失**（鼠标/键盘活动在这个模式下也不会停铃声，只能点按钮或等时长用完）。
2. **隐式的鼠标/键盘活动**：点一下页面或按任意键就停——但要先响够 `minRingMs`（默认 3000ms，即"最短响铃"），避免刚响就被你自己无意识的动作掐掉。这一下同时解锁浏览器音频（同一个手势监听）。**这条规则在 `bannerPlacement: modal` 下不生效**，那种模式只认按钮。
3. **自然结束**：`durationMs` 用完。

新铃声会顶掉正在响的那一声（同一时刻只有一声）；设置页的"试听完成音"走同一条路径，因此也能预览这张卡片。

## 浏览器音频的两条现实约束

1. **需要一次用户手势。** 浏览器在用户与页面交互之前不允许自动播放。插件会在第一次 `pointerdown`/`keydown` 时解锁音频；设置页的"试听"按钮同样会解锁。如果页面刷新后你一直没碰过它，第一声可能被浏览器静音。
2. **页面必须开着。** 声音在浏览器里合成播放，没有 host 侧定时器或系统播放器：关掉标签页就不会再响。

## 范围

- 监听实例里**所有顶层会话**（不只当前打开的那个）。子代理会话不会自己响，它们只计入父会话的"还在工作"。
- 后台作业按**归属**判断：只有 `owner` 是该会话的 `running`/`stopping` 作业才算它的活；unowned 作业不影响判定。
- 作业名单是按会话订阅的，因此插件只为"最近活跃过"的会话开订阅（会话停止 10 分钟后自动释放），一个几百会话的实例不会因此开几百条流。

## 开发

```bash
npm install
npm run check        # 类型 + 单测 + 一致性 + 客户端形状 + 真实设置服务表单
npm run gen:sounds   # 重新生成 assets/sounds/*.wav 与 client/sounds.generated.js
npm run build        # lib/ + client/client.js
```

仓库结构：

- `src/config.ts` — 设置页渲染的 Schemastery schema（十四个字段全部 volatile）。
- `src/index.ts` — host 半边：只发布 schema，不挂任何监听、不起定时器。
- `client/main.ts` — 浏览器半边：会话监听、判定、播放、设置表单。
- `client/sounds.generated.js` — 由 `scripts/generate-sounds.ts` 生成的声音表（base64 WAV）。
- `scripts/build-client.mjs` — 把声音表与编译后的 `client/main.js` 拼成一个 classic script `client/client.js`。
- `scripts/check-settings-form.mjs` — 用**真实安装的** `@deepseek-ai/dsh-settings` 跑 `describe()`，证明插件页会渲染出这十四个控件。

## English

A DSH plugin that rings when a session **truly stops**: no running turn, no live background job owned by that session, and no working subagent. A goal that becomes `blocked` counts as a stop and can use its own chime. All top-level sessions of the instance are watched (subagent sessions never ring on their own).

Chimes, volume, the playback window (up to 6 hours; a short chime repeats until the window is used up, and any click or key press stops it), the quiet-period threshold, a local-time do-not-disturb window (which may cross midnight) and a one-click rest mode are set on the plugin's settings page and apply live; rest mode also has a 🌙/🔔 switch at the sidebar foot. The chimes are CC0 Kenney interface sounds bundled into the browser half, so playback is offline and happens in the browser: closing the page ends the ringing. Browsers need one user gesture before they allow audio, so the first `pointerdown`/`keydown` (or the page's 试听 button) unlocks the context.

Not published to npm; install from the GitHub Release tarball.

## License

MIT. Bundled audio is CC0 — see [THIRD_PARTY_NOTICES.md](<THIRD_PARTY_NOTICES.md>).
