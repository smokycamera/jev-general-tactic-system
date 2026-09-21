# 扩展教程

完整可编译示例在 `examples/extensions.ts`。

## 战法与风格

取得 `defaultDoctrines()`，用 `.register()` 添加 `TaskMethod`。提供唯一 ID、版本、所属大类、适用条件、评分、阶段生成和动作偏好。传入 `CommandRuntime({doctrines,...})` 即可参与分层选择，不需修改运行器。

风格通过 `defaultStyles().register({id,label,low,high,effect,contribution})` 注册。`contribution(features,value)` 返回其评分贡献。界面元信息来自注册表，新增维度可自动显示滑块；如在示例服务使用自定义注册表，也应将同一实例用于元信息接口与运行器。

自定义评价器实现 `Evaluator.evaluate()`，返回 `utility/risk/continuity`；选取器实现 `Selector.select()`。保留这些分项，便于定位某个偏好是否压过任务收益。

## 能力与流程

`profiles` 可以覆盖内置档位，或添加新 ID 后让指挥官引用。候选上限、阶段跨度、评价因素、协作层级、预案和敌方响应项分别可调。

新步骤实现 `DecisionStage`，声明依赖并通过 `extraStages` 注册。默认追加运行，或在 `workflow.stages` 中明确启用顺序。依赖决定实际顺序，循环、缺失模块和缺失能力会在启动时被拒绝。复杂计算应检查 `context.signal`，取消后停止写入临时结果。

最终版本检查、授权检查、保存及执行去重仍由运行器负责。不要在步骤里绕过 `BattleAdapter.execute()` 直接改宿主状态。

## 地图与宿主

实现 `BattleAdapter`：

- `observe()` 返回当前可见事实和严格递增版本。
- `legalActions(observation,unitIds)` 只返回该观察下可执行的动作，包括必要的待命／结束行动。
- `execute(envelope)` 原子验证会话与状态、扣资源、结算和登记回执。
- `receipt(key)` 可在重启后查询已经结算的动作。
- `snapshot()` 返回可序列化宿主状态；示例宿主还实现了显式 `restore()`。

地图位置使用字符串 ID 与相邻列表，可表示格子、房间、阵地区域或通路。坐标主要供示例地图显示；真实宿主可采用自己的路径与 LOS 算法，把结果体现在合法动作和特征中。

对新的移动规则、地图规模和胜负条件，应补充行为测试。演示适配器的简化 HP/AP/射程不代表现有酒馆引擎的真实规则。

## 模型与回放

提供方实现 `DecisionProvider.evaluate(request,signal)`，对当前候选返回 0–1 分值和置信度。不可注入新动作 ID，不可直接提交动作。

`runtime.state.records` 保存实际问题和回答。将其传给 `ReplayProvider`，使用相同初始状态、种子和配置运行，可重现模型成功响应下的动作序列。请求内容不匹配时拒绝回放，避免把旧答案套用到新局面。含超时／冷却的录制还受时间推进影响，严格故障时序回放可通过运行器的 `clock: { now() }` 注入可控时钟，并由测试控制超时完成时刻。
