# dsh-meeting-memo · 会议纪要

DeepSeek Harness 右侧栏的会议纪要插件。在本机录下会议、用本地语音模型转成文字，再把选中的一段整理成结构化纪要：背景、要点、决策、待办。音频和文字都不离开这台机器。

## 安装

```bash
# 从 npm
dsh plugin --profile <你的 profile> add dsh-meeting-memo

# 或直接从 GitHub（首次会自动构建）
dsh plugin --profile <你的 profile> add github:jqlong17/dsh-meeting-memo
```

装完**重启 DSH**：插件只在启动时扫描一次。

首次使用会申请麦克风和屏幕录制权限——前者录你说的话，后者录会议另一端的声音。

语音模型在「转写服务」里下载，插件会按系统给出对应选项：

- **macOS**：SenseVoiceSmall_int8（苹果 Core ML，约 227 MB），走神经引擎，内存占用明显更小。
- **其它系统**：sensevoice-small ONNX fp32（约 1 GB）。

## 面板里有什么

| 标签 | 用途 |
| --- | --- |
| 今日 | 06:00–24:00 的语音密度；拖选一段看转写，滚轮缩放，拖底部滑块平移 |
| 纪要 | 整理好的纪要，按场次列出背景、要点、决策、待办；写法可自己改 |
| 背景 | 项目、人名、术语卡片，生成时勾选带上 |
| 任务 | 生成任务的进度与历史 |
| 转写服务 | 模型、语言、分轨和录音设置 |
| 关于 | 产品说明，以及一段可直接转发的安装话术 |

关掉插件后不再录音、不再整理。已经写下的纪要和背景留在本机。

## 它访问什么

这一节是为了让你在装之前就知道边界。

| 资源 | 用途 | 是否离开本机 |
| --- | --- | --- |
| 麦克风 | 采集现场说话 | 否 |
| 屏幕录制（仅系统音频） | 采集会议另一端的声音 | 否 |
| `~/.dsh/meeting-memo/` | 存放纪要、转写、背景卡、模型与运行时 | 否 |
| 本机模型文件 | 你指定目录下的语音模型（如 SenseVoice） | 否 |
| 网络 | 下载你主动选择的语音模型；生成纪要时调用模型 | 录音与转写内容不上传 |

补充两点：

- **飞书链接**：只有你把链接贴进「补充资料」时，才会调用本机的 `lark-cli`（用你自己的登录态）读取文档或表格。不贴就不读。
- **不碰别人的数据**：不写入 notta 生活日志目录，不修改其他插件的配置。

## English

A right-sidebar meeting-minutes plugin for DeepSeek Harness. It records the meeting on this machine, transcribes locally with an on-device speech model, and turns a selected span into structured minutes: background, key points, decisions, and to-dos. Audio and text never leave the machine.

```bash
dsh plugin --profile <profile> add dsh-meeting-memo
```

Restart DSH after installing; plugins are only scanned at startup. The first run asks for microphone and screen-recording permission. Model and recording settings live under **Transcribe**.

**What it touches.** Microphone audio and system audio for capture; `~/.dsh/meeting-memo/` for minutes, transcripts, background cards, models, and the ASR runtime; the network only to download a model you pick, or to call the model when drafting minutes. Nothing recorded or transcribed is uploaded. Feishu links are read through your local `lark-cli` only when you paste them into Extra notes. It does not write to the notta life-log folder or modify other plugins' config.

## 开发

```bash
npm install
npm run build        # lib/index.js + lib/client.js
npm test             # 21 项单测
npm run check:client # 校验打包产物：tab、locale、文案、组件渲染
```

MIT
