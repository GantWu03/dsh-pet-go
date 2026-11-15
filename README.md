# dsh-pet-go 🐾

**一只极简的大肥鱼桌宠——以成为能真正陪你干活的小女仆为最终导向。**

本项目基于[dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的形象进行精简，并把核心目标聚焦于：**让桌宠知道你在干什么，并且能陪你干活。**（它现在是你的秘书了）

## 它和"观赏型"桌宠的区别

| | 观赏型桌宠 | dsh-pet-go |
|---|---|---|
| 观赏性 | 动作丰富，眼花缭乱 | 极简、更关注实用性 |
| 想找他说话 | 对话入口隐蔽 | 一键开始对话窗口 |
| 和她讨论正在看的内容 | 看不到屏幕，需要你手动截图 | 随时和你看同一块屏幕 |
| 信息不够时 | 会让你"再截个图发我" | 自己去查当前窗口、读完整文件、获取上下文信息，不反问你 |
| 让他干活 | 干不了 | 调用DeepSeek桌面端全部能力，DSH能干啥，她就能干啥 |
| 对话记录 | 看不到 | 保存在DSH工作区，随时翻阅 |


一句话：**它是一个能看到你的屏幕、能自己理解你在做什么、能调用全部 DSH 能力的实用型桌宠。** 贪玩、卖萌、碎碎念这些都不做——省下来的每一行代码都不吃干饭。

![她读到你屏幕上的文档，在气泡里给出结论](docs/shot-answer.png)

## 它是怎么干活的

- **截图和问题合成一条普通用户消息**进专属会话，模型看到的就是你看到的。
- 那个会话挂了 `standard` preset 和本机全权限：画面里能直接答的直接答，画面不够就自己查——读文档、看前台窗口、跑脚本，而不是让你"把文件发我"。
- 行为规则写在会话工作区的 `AGENTS.md` 里，由 DSH 原生注入；机器事实（系统、shell、python、屏幕尺寸）每次启动刷新。
- 浮窗是独立 Electron 进程，DSH 最小化也照常工作；崩了自动重启，连接断了自动重连。
- 气泡就是回答本身：先出结论，通常三四句话；鼠标停在上面可滚动、可关闭，20 秒后淡出。

## 快速开始

两种装法，任选一种。

**插件页（推荐）**：打开 DSH 的**插件**页 →「添加插件」→ 选发布包解压后的目录（或 `pnpm release` 生成的 `release/dsh-pet-go-<version>/`）。装完浮窗出现在屏幕右下角；重启 DSH 后仍在。

**从源码**：

```powershell
pnpm install
pnpm verify                                  # build + tsc + 依赖规则 + 测试
# 插件页「添加插件」选择 D:\work\dsh-pet-go\packages\host
```

改完代码必须 `pnpm build` 才生效（运行的是 `packages/host/lib` 与 `packages/helper/dist`）；改了 host 侧还要在插件页把该插件关一次再开，helper 侧强杀 `electron` 进程会在 1 秒内自动重启。

## 用起来

- **点击浮窗**：打开/收起输入条。**热键** `Ctrl+Shift+Space`（右键菜单里可换）。
- **Enter** 发送，**Shift+Enter** 换行，**Esc** 收起；输入条上的「截图」开关关掉就只发文字。
- **右键浮窗**：换形象、换热键、开机自启、打开时自动聚焦、复位位置、隐藏浮窗、退出。
- 隐藏后：点**托盘图标**、按**热键**、或再启动一次都能唤回。
- 第一次启动会弹一次提示气泡，告诉你它就是用来提问的、而且会带截图。

![输入条：打一句话，附一张截图](docs/shot-composer.png)


## 隐私与权限（重要）

- **它会截屏**。每次提问默认附带一整块屏幕的 PNG（含浮窗自己），作为附件存进 DSH 并发给你配置的模型服务商。关掉「截图」开关就只发文字。
- **它的会话有完整读写权限**：`sandbox/mode = danger-full-access`、审批策略 `never`（没人能在浮窗里点"允许"，不这样会永久挂起）。`AGENTS.md` 要求它**默认只读**，只有你明确要求时才改文件——但这是模型遵守的规则，不是系统强制。
- **它在你自己机器上跑**：截图、会话、日志都在 `%USERPROFILE%\.dsh\` 下，除了随消息发给模型服务商的内容，什么都不外发。
- 卸载插件后浮窗进程退出，不再截屏。

## 数据落在哪

| 路径 | 内容 |
|---|---|
| `%USERPROFILE%\.dsh\dsh-pet-go\workspace\AGENTS.md` | 会话指引 + 机器事实（每次启动重写） |
| `%USERPROFILE%\.dsh\dsh-pet-go\state.json` | 当前专属会话 id |
| `%USERPROFILE%\.dsh\dsh-pet-go\host.log` | 两端共用的日志（排查先看它） |
| `%USERPROFILE%\.dsh\dsh-pet-go\env.json` | 最近一次机器事实快照 |
| `%APPDATA%\@dsh-pet-go\helper\config.json` | 热键、形象、开机自启、聚焦行为 |
| `%APPDATA%\@dsh-pet-go\helper\window-state.json` | 浮窗位置 |

## 环境要求

| 项 | 要求 |
|---|---|
| 系统 | Windows 10 / 11（只在这些上验证过） |
| DSH | 0.2.2-rc.2 验证通过；版本不匹配时浮窗会提示"版本对不上" |
| Electron | 复用 DSH 自带的 `%USERPROFILE%\.dsh\electron`，不需要单独安装 |
| Node / pnpm | 只在从源码构建时需要（Node ≥ 22.18，pnpm 10） |

## 故障排查

- **浮窗不出现**：看 `host.log` 有没有 `using helper:` 和 `helper spawned`；没有多半是 Electron 找不到，用 `DSH_COMPANION_ELECTRON` 指定 `electron.exe`。
- **热键没反应**：可能被别的软件占用，右键菜单里换一个。
- **托盘图标找不到**：Windows 默认把新图标折叠进右下角 `^`，拖出来固定即可。
- **回答不动**：日志里搜 `request failed` / `agent error`；显示"DSH 还没准备好"时等几秒重试。
- **回答太长**：`AGENTS.md` 里已经要求先说结论、三四句话以内；仍嫌长可以直接告诉它"简短点"。

## 开发

```powershell
pnpm build     # host -> packages/host/lib，helper -> packages/helper/dist
pnpm check     # tsc 严格检查 + 四条依赖规则（含通过/违规样例）
pnpm test      # node --test，直接跑 TS 源码
pnpm release   # 构建并组装 release/dsh-pet-go-<version>/，自带打包自检
```

架构与取舍见 [technical-design.md](./technical-design.md)、[architecture.md](./architecture.md)；扩展手册见 [docs/extending.md](./docs/extending.md)；进度见 [PLAN.md](./PLAN.md)。

## 授权与归属

- 本项目代码：MIT，见 [LICENSE](./LICENSE)。
- 大肥鱼形象（`packages/helper/assets/pets/baifan/` 下六个 webm）来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。上游的授权是**代码 MIT、素材禁止商用、公开渠道二创须署名**；本项目只在个人非商业使用的前提下内置这六个动作，声明见 [NOTICE.md](./NOTICE.md)。要商用请自行向上游取得授权。
- 图标 `packages/host/icon.svg` 为本项目原创。
