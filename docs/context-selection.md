# 宿主定义的上下文选择（0.2.3）

`ContextSelector` 是一个独立、无状态的配置选择接口。宿主提交已完成消息、JSON 状态和有限候选项，JEV 一次批量返回各字段的候选值及置信度。核心不会定义地图、游戏模式、指挥风格阈值，也不会自动修改战斗或存档。

```ts
const request: ContextSelectionRequest = {
  messages: [{ id: 'm1', role: 'assistant', completed: true, text: '交战在森林中展开。' }],
  state: { phase: 'setup' },
  fields: [{
    id: 'terrain', question: '当前战场环境是什么？',
    options: { unknown: '没有明确依据', forest: '森林', plains: '平原' },
  }],
};
const result = await selector.selectContext(request, signal);
// { model: '...', selections: { terrain: { value: 'forest', confidence: 0.9 } } }
```

使用本机网关时，以 JSON POST 到 `/api/bridge/select-context`，携带 `Authorization: Bearer <JEV_SERVICE_TOKEN>`。服务必须配置 JEV 提供方；`/api/meta` 的 `bridge.selection` 表示是否可用。沿用 Origin 校验，单次请求超时 10 秒，关闭请求会取消提供方调用。SDK 内部重试关闭。

每次允许 1–32 个字段，每个字段 2–32 个选项；字段和选项 ID 采用小写字母开头的字母、数字、下划线或连字符，最多 64 个字符。返回值必须属于请求的候选列表，置信度必须处于 0–1。`unknown`/`keep` 是宿主可提供的普通候选项，其实际含义与落地策略由宿主决定；核心没有统一置信度阈值。

该接口使用 `choice`，直接复用 JEV 密钥，不需要 `TEXT_API_*`。原 `/api/bridge/context` 是独立的正文目标提取接口，仍需要文本模型配置。开战前的批次由宿主预算；战斗期间若同时调用选择与评分接口，宿主应合并计数。服务器不会保存一份影子战场。

酒馆 0.2.0-rc.8 将敌方能力、14 维风格、战斗形式、地形、昼夜、布局和胜利任务放入同一批选择；具体名单、手动优先规则、战斗中更新条件及引擎容量检查全部位于酒馆适配器。其他游戏可复用同一接口并提供自己的字段，不必引入酒馆术语。
