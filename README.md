# dsh-pet-go · 桌面小助手

一个常驻桌面的小浮窗，连着 DeepSeek Harness。点它（或按 `Ctrl+Shift+Space`）打字提问，它会连同**一张当前屏幕截图**把问题送进一个专属 DSH 会话，回答以气泡形式流式出现在浮窗旁边。

![浮窗与气泡](docs/m4-pet-and-bubble.png)

## 它是怎么干活的

- 截图和问题作为**一条普通用户消息**进入会话，所以模型看到的就是你看到的。
- 那个会话挂了 `standard` preset，有完整工具和本机读写权限：截图不够时，模型会自己去读文件、跑命令，而不是反问你"把文件发我"。
- 行为规则写在会话工作区的 `AGENTS.md` 里，由 DSH 原生注入；机器事实（系统、shell、python、屏幕尺寸）每次启动刷新。
- 浮窗是独立 Electron 进程，DSH 最小化也照常工作；崩溃后自动重启。

## 环境要求

| 项 | 要求 |
|---|---|
| 系统 | Windows 10 / 11（目前只在这些上验证过） |
| DSH | 0.2.2-rc.2 验证通过；版本不匹配时浮窗会提示"版本对不上" |
| Electron | DSH 桌面版自带的 `%USERPROFILE%\.dsh\electron` 会被复用，不需要单独安装 |
| Node / pnpm | 只在从源码构建时需要（Node ≥ 22.18，pnpm 10） |

## 安装

### 从发布包安装（推荐）

1. 下载并解压 release 包（或 `npm pack` 出来的 `.tgz`），得到一个包含 `package.json`、`lib/`、`helper/` 的目录。
2. 打开 DSH 的**插件**页 →「添加插件」→ 选这个目录。
3. 装载后浮窗应出现在屏幕右下角；重启 DSH 后仍在。

### 从源码安装（开发）

```powershell
pnpm install
pnpm verify        # build + tsc + 依赖规则 + 测试
# 插件页「添加插件」选择 D:\work\dsh-pet-go\packages\host
```

改完代码必须 `pnpm build` 才会生效（运行的是 `packages/host/lib` 和 `packages/helper/dist`，不是源码）。改了 host 侧还要在插件页把这个插件关一次再开（helper 侧强杀 `electron` 进程，1 秒内会自动重启）。

## 使用

- **点击浮窗**：打开/收起输入条。**热键** `Ctrl+Shift+Space`（可在右键菜单里换）。
- **Enter** 发送，**Shift+Enter** 换行，**Esc** 收起。
- 输入条上的「截图」开关：关掉就只发文字。
- **右键浮窗**：换形象、换热键、开机自启、打开时自动聚焦、复位位置、打开输入条、隐藏浮窗、退出。
- 隐藏后：点**托盘图标**、按**热键**、或再启动一次都能唤回。
- 气泡 20 秒后变半透明、再过 10 秒消失；鼠标停在气泡上会保持可见，并出现关闭按钮。

![输入条](docs/m2-composer.png)

## 隐私与权限（重要）

- **它会截屏**。每次提问默认附带一整块屏幕（含浮窗自己）的 PNG，作为附件存进 DSH 并发送给你配置的模型服务商。关掉输入条上的「截图」开关就只发文字。
- **它的会话有完整读写权限**：`sandbox/mode = danger-full-access`、审批策略 `never`（没人能在浮窗里点"允许"，不这样会永久挂起）。`AGENTS.md` 要求它**默认只读**，只有你明确要求时才改文件，但这是模型遵守的规则，不是系统强制。
- **它在你自己的机器上跑**：截图、会话、日志都留在本地（`%USERPROFILE%\.dsh\` 下），除了随消息发给模型服务商的内容。
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

## 故障排查

- **浮窗不出现**：先看 `host.log` 有没有 `using helper:` 和 `helper spawned`。没有的话多半是 Electron 找不到（设置环境变量 `DSH_COMPANION_ELECTRON` 指向 `electron.exe`）。
- **热键没反应**：可能被别的软件占用；右键菜单里换一个。
- **托盘图标找不到**：Windows 默认把新图标折叠进右下角 `^` 里；拖出来固定即可。
- **回答不动**：看日志里有没有 `request failed` / `agent error`；`DSH 还没准备好` 时等几秒重试。
- **旧版路径**：`%USERPROFILE%\.dsh\companion\` 会在第一次启动时迁移到 `dsh-pet-go\`，旧路径保留为一个 junction，供已经存在的会话继续使用。

## 卸载

插件页里移除这个插件 → 浮窗进程退出 → 视需要删掉 `%USERPROFILE%\.dsh\dsh-pet-go\` 和 `%APPDATA%\@dsh-pet-go\`。

## 开发

```powershell
pnpm build     # host -> packages/host/lib，helper -> packages/helper/dist
pnpm check     # tsc 严格检查 + 四条依赖规则（含通过/违规样例）
pnpm test      # node --test，直接跑 TS 源码
pnpm release   # 构建并组装 release/ 下的可分发目录
```

架构与取舍见 [technical-design.md](./technical-design.md)、[architecture.md](./architecture.md)；扩展手册见 [docs/extending.md](./docs/extending.md)。

## 授权

本项目 MIT（见 [LICENSE](./LICENSE)）。大肥鱼形象的 webm 素材来自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，同样以 MIT 授权，声明见 `packages/helper/assets/pets/baifan/NOTICE.md`。
