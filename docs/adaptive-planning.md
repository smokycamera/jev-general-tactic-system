# Adaptive targeting and bounded memory

Version 0.2.2 keeps fixed objectives separate from observed contacts and search waypoints. These mechanisms use only `Observation`, the map graph, legal host actions and durable receipts. The core contains no game engine, chat, grid-size or game-mode branches.

## Targets

- An explicit `Goal.target` is a fixed location. Capture and defense remain active until the host reports completion, including objectives that require holding a point for several turns.
- Without a fixed objective, a visible contact is selected by distance from the entire group, retaining the current contact while visible. A `TaskSpec.targetUnitId` binds a pending or active step to that observed unit. Completed preparatory steps are retained; ordinary contact movement does not require another model request.
- In a partially observed elimination/reconnaissance mission, missing contacts trigger `search-contact`. The planner first checks an unvisited last-known contact location, then selects reachable unvisited waypoints using known map geometry. Waypoints are kept while travelling. Contact discovery changes the plan immediately. Search is exploration, not a claim about an unseen enemy location.

Ranged units may complete their approach within weapon range. Engagement prefers available attacks to unnecessary additional closing, while host legality remains authoritative for visibility, line of fire and resources. Fixed objective movement retains its priority.

## Memory and model input

`Checkpoint.memory` is optional for backwards compatibility. Each side retains at most 512 visited location IDs and 24 `RecentAction` records containing the submitted action, turn and receipt outcome. Reconciliation deduplicates history with the durable receipt; asynchronous outcomes update when the host reports completion. This is a bounded operational history, not a full battle transcript or hidden enemy state.

`DecisionRequest.recentActions` contains only the requesting side's history. Each doctrine candidate includes executable `steps`: unit assignment, target, optional observed unit binding and dependencies. The JEV provider forwards these proposals without local utility totals, so its evaluation is independent of local ranking scores.

Valid model evidence uses the existing bounded additive blend, `localTotal + modelScore * 3 * confidence`, without a separate confidence cliff. Zero confidence leaves local ranking unchanged. Invalid responses, timeouts and exhausted budgets retain the existing fallback behavior. This does not guarantee that the model will change the local choice or improve win rate. `Checkpoint.lastModelSelection` records the model, confidence, observation version, local choice and selected choice for inspection.

Old checkpoints omit the optional fields and build memory from subsequent observations. The next planning boundary migrates an old unbound tactical plan. Search history is reset with the host session/checkpoint; a host should use a fresh identity when loading a different battle.

## Host integration

Hosts report visible units and their actual current health in consistent units, declare supported movement/flanking mechanisms, and expose only legal commands. A unit binding never grants visibility or bypasses command validation. The tavern adapter maps member health and formation mechanics; those rules do not enter the core.

Search is a bounded generic fallback, not optimal reconnaissance, probabilistic enemy tracking, or a replacement for an RTS/FPS navigation/perception system. A host can supply explicit objectives and custom task methods when richer behavior is available.
