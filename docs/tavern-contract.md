# 酒馆可选 JEV 接入

当前宿主为 `smokycamera/sillytavern-general-battle-system` 的 GitHub 0.2.0-rc.8，配套本服务 0.2.3。旧存档和新安装默认使用原有自动 AI；选择“JEV 指挥”后，使用本框架的计划、HTN 执行与可选模型评价。旧 V1 战斗继续使用原 AI。

## 运行

1. 在本仓库执行 `npm ci`、`npm run build`。
2. 复制 `.env.example` 为 `.env`，填写 `TYPESAFE_API_KEY`，设置随机的 `JEV_SERVICE_TOKEN`。
3. `JEV_ALLOWED_ORIGINS` 填酒馆实际 Origin，多个用逗号分隔，例如 `http://localhost:8000,http://127.0.0.1:8000,http://tauri.localhost,https://tauri.localhost,tauri://localhost`。
4. `npm start` 启动本机服务。在酒馆设置页填写 `http://127.0.0.1:4317` 和服务令牌，点击“保存连接并测试”。
5. 切换“JEV 指挥”，使用原有自动行动或全自动开关。暂停或收起面板会取消等待中的请求。

模型密钥只在服务端。本机服务令牌保留在浏览器 sessionStorage，不进入聊天存档；地址保留在 localStorage。浏览器的 HTTPS/本机请求策略仍需由实际宿主验证，连接测试会报告失败。

## 分工与保存

- 酒馆内置带来源提交号和文件校验的核心副本，前端不远程加载代码。`POST /api/bridge/evaluate` 只调用模型评分，`POST /api/bridge/context` 只提取正文，`POST /api/bridge/select-context` 批量回答宿主定义的配置选择；服务器不保存或推进酒馆战斗。
- `TavernJevAdapter` 分别使用当前阵营的 `visibleCombatants`，不合并双方视野。中立单位不自动授予控制权。
- 小战使用引擎原有的攻击、冲锋、技能、移动、固守和结束行动查询；会战军令通过 `orderPreview`、`issue` 和原有阶段结算。伤害、护甲、LOS、资源和掷骰不重写。
- 规划在私有战斗副本中进行。整个激活／会战回合完成后，面板重检聊天代次、版本和取消状态，将战斗快照、计划和回执作为同一候选交给既有原生存储服务。
- 中间 `pending` 只存在于私有事务，不单独写入聊天。持久化只接受 `pending:null` 的完成检查点。保存结果待核实时由既有 journal 核实同一候选，不重新请求模型或重新掷骰。
- 刷新恢复已确认计划；全自动开关需重新打开。手动改变战场后使旧计划失效，下次按新事实重建。
- 模型请求失败时丢弃私有候选，原 AI 从同一初始快照推进；30 秒后允许重新探测。

通用宿主若将每条动作即时交给外部执行，仍必须按 `ActionEnvelope.key` 将动作和回执原子持久化。本适配采用完整候选事务，不暴露未保存的中间动作。

## 正文策略

```json
{
  "windowSize": 6,
  "roles": ["assistant"],
  "trigger": ["battle-start", "message-change", "manual"],
  "mode": "auto"
}
```

以上配置放在 `RuntimePolicy.narrativeContext`。mode 支持 auto/manual/off；trigger 支持 battle-start/message-change/decision/manual。自动扫描在下次决策边界检查消息变化，手动扫描不推进战斗。旧 narrativeWindow/narrativeRoles/narrativeMode 保持兼容，新配置优先；窗口 0 表示不读取消息。

正文提取需要配置 TEXT_API_URL/TEXT_API_KEY/TEXT_MODEL。酒馆默认关闭。输出只允许 goals、battleType、environment、summary；未知字段丢弃，不能修改单位事实。该提取接口不负责能力或风格；0.2.3 的独立配置选择接口由酒馆用于敌方能力、风格与开战场景。

## 范围

这是一版可运行的 V2/V4 接入，不是战斗平衡版本。未映射的特殊组合或无法推进的任务由原 AI 完成剩余行动。历史独立面板使用适配器可提供的最近文本作为单条上下文，原生消息接口则保留消息角色、完成状态与窗口。未配置文本模型时不执行正文语义提取。真实用户存档与长期战术表现仍需实际使用验证。

## 同批开战判定

酒馆选择 JEV 模式且使用 V2/V4 规则时，可在开战前通过一个 JEV 批次选择敌方能力、14 维指挥风格、地形、昼夜、标准/室内地图、小战/会战及任务。默认读取最近 6 条完成的 assistant 消息；窗口为 0 时不读取。该功能只需 JEV，不依赖额外文本模型。

场景在开战时冻结。敌方配置随战斗保存，重复消息窗口不请求；后续新正文明确更换指挥官或改变其状态时，适配器才允许更新能力/风格。手动设置优先，信息缺失与服务失败沿用默认配置。适配器检查小战/会战的编制和目标兼容性；等待中取消或上下文变化会丢弃未提交的准备结果。参见 [通用接口](context-selection.md)。
