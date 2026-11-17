/**
 * 「关于」页的文案：产品介绍 + 可直接转发的安装话术。
 *
 * 纯文本、无 Node 依赖，面板直接引用。改版本号时这句话术会跟着变，
 * 不会出现「界面 0.2.0、话术 0.1.x」这种不一致。
 */

export const PACKAGE_NAME = 'dsh-meeting-memo'

export const INTRO_ZH: string[] = [
  '「会议纪要」是 DeepSeek Harness 的右侧栏插件。它在本机持续采集麦克风和系统声音，用本地语音模型转成文字，再把选中的一段交给模型整理成结构化纪要：背景、要点、决策、待办。',
  '正在开会时点「打点开始」，散会点「结束这场」，这段时间就是选区，接着生成即可。项目、人名、术语写进「背景」卡片，生成时勾选带上，模型会按你的语境理解内容。',
  '音频、转写和纪要都留在这台机器上，不上传云端。转写用哪个模型、认哪种语言、怎么分轨，都在「转写服务」里调。',
]

export const INTRO_EN: string[] = [
  'Meeting Minutes is a right-sidebar plugin for DeepSeek Harness. It captures the microphone and system audio on this machine, transcribes locally with an on-device speech model, and turns a selected span into structured minutes: background, key points, decisions, and to-dos.',
  'When a meeting starts, tap Mark start; when it ends, tap End meeting — that span becomes the selection, ready to draft. Project, people, and term cards go into Background and can be ticked when generating, so the model reads content in your context.',
  'Audio, transcripts, and minutes stay on this machine and are never uploaded. Which model to use, which language to recognise, and how to split tracks all live under Transcribe.',
]

/** 别人把这段话丢给任意一个能操作本机的 AI，就能自己把插件装上并把模型配好。 */
export function buildSharePrompt(): string {
  // 不写死版本号：插件一直在更新，让对方直接装最新的就行
  return `请帮我在 DeepSeek Harness 上安装插件 ${PACKAGE_NAME}（中文名「会议纪要」），并把语音模型按这台机器的系统配好。

它是右侧栏的会议纪要插件：本机录音、本地转写，再把选中的一段整理成背景、要点、决策和待办。音频和文字都不离开这台机器。

请按顺序做，每步做完告诉我结果：

1. 确认当前 DSH 的 profile 名称（一般看 ~/.dsh/profiles/ 下哪个是你在用的）。
2. 安装：dsh plugin --profile <你的profile> add ${PACKAGE_NAME}@latest
   如果 npm 上取不到这个包，直接告诉我，别自己改写依赖或去装同名的其它包。
3. 重启 DeepSeek Harness。插件只在启动时扫描一次，不重启不会出现。
4. 按系统选语音模型，这一步由你判断，不要让我自己挑：
   - 先运行 uname -s 确认系统。
   - 是 Darwin（macOS）：在「转写服务」里选「SenseVoiceSmall_int8 苹果 Core ML」并点下载，约 227 MB。它走 Apple 神经引擎，内存占用比通用版小一个数量级。
   - 不是 macOS：选「sensevoice-small ONNX fp32」并点下载，约 1 GB。
   - 下载由插件自己完成，不要手动往模型目录拷文件。如果「转写服务」里没有出现这两个条目，说明插件没加载成功，回到第 2 步。
   - 下载完成后在列表里点一下该模型，确认它显示「使用中」。
5. 首次使用会申请麦克风和屏幕录制权限，请提醒我在系统设置里授权。
6. 最后打开右侧栏「会议纪要」，界面能正常显示就说明装好了。

如果哪一步报错，把错误原文贴给我，不要猜着改配置文件。`
}

export function buildSharePromptEn(): string {
  return `Please install the DeepSeek Harness plugin ${PACKAGE_NAME} (Meeting Minutes) on this machine, and set up the speech model for this OS.

It is a right-sidebar meeting-notes plugin: local capture, local transcription, then a selected span becomes structured minutes with background, key points, decisions, and to-dos. Audio and text never leave this machine.

Do this in order and report back after each step:

1. Find the DSH profile in use (usually one of ~/.dsh/profiles/).
2. Install: dsh plugin --profile <profile> add ${PACKAGE_NAME}@latest
   If npm cannot resolve the package, tell me instead of substituting another package.
3. Restart DeepSeek Harness. Plugins are only scanned at startup.
4. Pick the speech model for this OS — you decide, do not ask me:
   - Run uname -s first.
   - Darwin (macOS): choose "SenseVoiceSmall_int8 苹果 Core ML" under Transcribe and download it, about 227 MB. It runs on the Apple Neural Engine and uses an order of magnitude less memory than the cross-platform build.
   - Anything else: choose "sensevoice-small ONNX fp32", about 1 GB.
   - The plugin performs the download; do not copy files into the model folder by hand. If neither entry appears under Transcribe, the plugin did not load — go back to step 2.
   - When it finishes, click the model in the list and confirm it shows as in use.
5. The first run asks for microphone and screen-recording permission on macOS; remind me to grant it.
6. Open Meeting Minutes in the right sidebar; if the panel renders, it is installed.

If any step fails, paste the raw error back to me rather than editing config files on a guess.`
}
