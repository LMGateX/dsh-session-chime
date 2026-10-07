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

## 设置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关掉后没有任何提示音，行与设置都保留 |
| `soundDone` | `chime-soft` | 完成铃声，6 个可选 |
| `soundBlocked` | `alert-low` | 受阻铃声，6 个可选 |
| `volume` | `0.8` | 音量 0–1 |
| `durationMs` | `0` | 播放时长上限；0＝完整播一次，正数＝最多响这么久（短铃声自动重复，上限 8 秒） |
| `debounceMs` | `1500` | 安静判定：停下后要安静这么久才算结束，用来躲开回合间隙 |

六个铃声（全部 CC0，来自 Kenney "Interface Sounds"）：`chime-soft` 柔和双音、`bell-bright` 清脆铃、`marimba` 木琴上行、`alert-low` 低沉警示、`alert-sharp` 短促警示、`blip` 轻点。设置页里点击 **试听完成音** 可以直接听。

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

- `src/config.ts` — 设置页渲染的 Schemastery schema（六个字段全部 volatile）。
- `src/index.ts` — host 半边：只发布 schema，不挂任何监听、不起定时器。
- `client/main.ts` — 浏览器半边：会话监听、判定、播放、设置表单。
- `client/sounds.generated.js` — 由 `scripts/generate-sounds.ts` 生成的声音表（base64 WAV）。
- `scripts/build-client.mjs` — 把声音表与编译后的 `client/main.js` 拼成一个 classic script `client/client.js`。
- `scripts/check-settings-form.mjs` — 用**真实安装的** `@deepseek-ai/dsh-settings` 跑 `describe()`，证明插件页会渲染出这六个控件。

## English

A DSH plugin that rings when a session **truly stops**: no running turn, no live background job owned by that session, and no working subagent. A goal that becomes `blocked` counts as a stop and can use its own chime. All top-level sessions of the instance are watched (subagent sessions never ring on their own).

Chimes, volume, playback window and the quiet-period threshold are set on the plugin's settings page and apply live. The chimes are CC0 Kenney interface sounds bundled into the browser half, so playback is offline and happens in the browser: closing the page ends the ringing. Browsers need one user gesture before they allow audio, so the first `pointerdown`/`keydown` (or the page's 试听 button) unlocks the context.

Not published to npm; install from the GitHub Release tarball.

## License

MIT. Bundled audio is CC0 — see [THIRD_PARTY_NOTICES.md](<THIRD_PARTY_NOTICES.md>).
