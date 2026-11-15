# 扩展手册

三条最常见的改动，每条都写了**改哪**、**跑什么验证**。改完记得 `pnpm build`——运行的是产物，不是源码。

## 1. 加一个形象

形象只负责"长什么样"，不负责窗口、输入、气泡、截屏。

**新素材（webm 片段）**

1. 把素材放进 `packages/helper/assets/pets/<name>/`，写一个 `pet.json`：

   ```json
   {
     "name": "显示名",
     "stage": { "width": 640, "height": 360 },
     "viewport": { "x": 168, "y": 2, "width": 308, "height": 334 },
     "preferred": { "width": 90, "height": 98 },
     "states": {
       "idle": { "clip": "idle.webm", "loop": true },
       "thinking": { "clip": "thinking.webm", "loop": true }
     }
   }
   ```

   `viewport` 必须是**全部片段所有帧的不透明像素并集**，否则某个动作会被窗口切掉。测量方法见
   `packages/helper/assets/pets/baifan/MEASUREMENTS.md`（FFmpeg 要加 `-c:v libvpx-vp9`，否则 alpha 会丢）。

2. 注册：`packages/helper/renderers/registry.js` 里加一行映射。

3. 菜单：`packages/helper/src/desktop.ts` 的 `petMenu()` 里给"形象"加一项（`setPet('<name>')`）。

4. 验证：

   ```powershell
   pnpm build
   # 重载插件或强杀 electron.exe（supervisor 1s 内重启）
   # 右键浮窗 → 形象 → 新形象；重启后仍是新形象
   ```

**纯代码形象（CSS/Canvas）**：实现 `PetRenderer` 契约（`renderers/types.js` 有说明）——`mount/measure/setState/dispose`，然后在注册表加一行。`measure()` 返回窗口需要的逻辑尺寸；窗口就是这么大的，画到外面会被裁。

> 坑：窗口尺寸来自 `measure()`。如果动画需要更大空间，必须在 `measure()` 里就返回大尺寸（clip 渲染器就是靠 `viewport` 这么做的），运行时再变大是不行的。

## 2. 换截屏实现

截屏是 helper 的 `captureActiveDisplay()`（`packages/helper/src/capture.ts`），一个函数，返回 `{ base64, mediaType, width, height }`，失败抛 `CaptureError(code)`，`code` 只能是 `CAPTURE_DENIED` 或 `CAPTURE_EMPTY`。

改法：

1. 在 `capture.ts` 里换实现（比如按窗口截、按区域截）。调用方只有 `main/index.ts` 的 `companion:submit` 分支。
2. 若要改"截不截"的语义（新档位），协议在 `packages/shared/src/protocol.ts` 的 `CAPTURE_MODE`，两端都要处理；`submit.ts` 里 `capture.mode === CAPTURE_MODE.screen` 决定是否带图。
3. 验证：

   ```powershell
   pnpm test          # 集成测试覆盖提交链路；capture 本身用真实截图人工确认
   pnpm build
   # 真机：点球 → 输入问题 → 气泡回答里能看出它看到了屏幕
   ```

错误链路要一起看：截图失败时 helper 返回 `{ ok:false, code:'CAPTURE_DENIED'|'CAPTURE_EMPTY', retryable:true }`，面板直接显示这句话，不会进 host。

## 3. 跟 DSH 升级

DSH 的变动只应影响 `packages/host/src/adapters/dsh.ts`。文件里每个 `ctx.get('…')` 就是一处耦合面：

| 服务 / API | 用途 | 变了会怎样 |
|---|---|---|
| `ctx.agents.create/resume/get` | 会话生命周期 | 提交失败、`AGENT_UNAVAILABLE` |
| `ctx.agents` 的 setup 回调 + `agentPresets.mount` | 挂 `standard` preset（34 个工具） | 模型只剩三个工具，答不出屏幕外的事 |
| `agent.session.append('sandbox/mode')` | 全权限 | 会话只能读工作区 |
| `approval.setPolicy(agent,'never')` | 免审批 | 回合永久挂起 |
| `ctx.attachments.saveImage` | 截图入库 | 带图提交失败 |
| `workspaceRegistry.create/list/attachSession` | 侧边栏可见 | 会话存在但看不到 |
| `sessionController.rename` | 会话命名 | 名字变回模型生成的 |
| `ctx.on('agent/assistant-stream'/'agent/status'/'agent/error')` | 气泡流式 | 气泡不更新 |

改法：只改这个文件；应用层用的是 `SessionPort` / `AgentEvent`，不认 DSH 的原始形状。如果事件形状变了，在 `events.subscribe` 里把它归一成现有的 `AgentEvent` 联合类型即可。

验证：

```powershell
pnpm check:types      # 适配器是唯一写 DSH 形状的地方
pnpm test             # 集成测试跑 fake DSH，不连真 DSH
pnpm build
# 真机：问一句看气泡流式回答；再让它查一个屏幕外的东西，确认工具还在（不是只有三个）
# 日志 %USERPROFILE%\.dsh\companion\host.log 里应有 "preset mounted"、"permissions: sandbox=… approval=never"
```

## 4. 新增一种帧

1. `packages/shared/src/protocol.ts`：加接口 + 加进 `ClientFrame` 或 `HostFrame` + 在 `parseClientFrame`/`parseHostFrame` 里校验必需字段。
2. host 侧：`transport/server.ts` 不需要动（校验在 shared），在 `companion.ts` 的 switch 里处理。
3. helper 侧：在 `host-client.ts` 交给 `onFrame`，在 `main/index.ts` 的 `onHostFrame` 里分派给窗口或 `windows` 模块。
4. 验证：`pnpm test`（`tests/frames.test.mjs` 按类型校验，`tests/integration.test.mjs` 校验端到端），再真机看一眼。

## 5. 常用命令

```powershell
pnpm build            # 两个产物：host/lib、helper/dist
pnpm check            # tsc 类型检查 + 依赖规则
pnpm test             # node --test，跑 TS 源码
pnpm verify           # build + check + test

# 重载插件（等价于点插件管理页里的开关）
#   plugin_manager set_bundle false → true
# 重载 helper
Get-Process electron | Stop-Process -Force   # supervisor 1s 内重启
```

日志只有一处：`%USERPROFILE%\.dsh\companion\host.log`，host 与 helper 都往里写（helper 的每行带 `[helper]`）。
