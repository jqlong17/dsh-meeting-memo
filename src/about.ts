/**
 * 「关于」页的文案：产品介绍 + 可直接转发的安装话术。
 *
 * 纯文本、无 Node 依赖，面板直接引用。改版本号时这句话术会跟着变，
 * 不会出现「界面 0.2.0、话术 0.1.x」这种不一致。
 */
import { PLUGIN_VERSION } from './version.ts'

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

/** 别人把这段话丢给任意一个能操作本机的 AI，就能自己把插件装上。 */
export function buildSharePrompt(version = PLUGIN_VERSION): string {
  return `请帮我在 DeepSeek Harness 上安装插件 ${PACKAGE_NAME}（中文名「会议纪要」，版本 ${version}）。

它是右侧栏的会议纪要插件：本机录音、本地转写，再把选中的一段整理成背景、要点、决策和待办。音频和文字都不离开这台机器，不需要把录音上传给任何云服务。

请按顺序做，每步做完告诉我结果：

1. 确认当前 DSH 的 profile 名称（一般看 ~/.dsh/profiles/ 下哪个是你在用的）。
2. 安装：dsh plugin --profile <你的profile> add ${PACKAGE_NAME}
   如果 npm 上取不到这个包，说明还没发布，请直接告诉我，别自己改写依赖或去装同名的其它包。
3. 重启 DeepSeek Harness。插件只在启动时扫描一次，不重启不会出现。
4. 打开右侧栏的「会议纪要」，确认标题下面刷新按钮右边的版本号是 ${version}。
5. 首次使用会申请麦克风和屏幕录制权限，请提醒我在系统设置里授权；本机语音模型第一次用时会自动准备，需要等一会儿。

如果哪一步报错，把错误原文贴给我，不要猜着改配置文件。`
}

export function buildSharePromptEn(version = PLUGIN_VERSION): string {
  return `Please install the DeepSeek Harness plugin ${PACKAGE_NAME} (Meeting Minutes, version ${version}) on this machine.

It is a right-sidebar meeting-notes plugin: local capture, local transcription, then a selected span becomes structured minutes with background, key points, decisions, and to-dos. Audio and text never leave this machine.

Do this in order and report back after each step:

1. Find the DSH profile in use (usually one of ~/.dsh/profiles/).
2. Install: dsh plugin --profile <profile> add ${PACKAGE_NAME}
   If npm cannot resolve the package, it is not published yet — tell me instead of substituting another package.
3. Restart DeepSeek Harness. Plugins are only scanned at startup.
4. Open Meeting Minutes in the right sidebar and confirm the version next to the refresh button reads ${version}.
5. The first run asks for microphone and screen-recording permission on macOS; remind me to grant it. The local speech model is prepared on first use and takes a while.

If any step fails, paste the raw error back to me rather than editing config files on a guess.`
}
