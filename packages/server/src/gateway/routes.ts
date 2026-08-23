import type { ModuleManifest } from './manifest.js';

/**
 * 接入层唯一的客户端路由表。
 * 领域模块不感知鉴权、会话注入、payload schema 或 WebSocket action。
 */
export const MODULE_MANIFESTS: ModuleManifest[] = [
  {
    moduleName: 'building',
    publicActions: {
      GetVillageLayout: { command: 'building.GetLayout', ownVillage: true, needAuth: true, schema: {} },
      GetBuildOptions: {
        command: 'building.GetBuildOptions', ownVillage: true, needAuth: true,
        schema: { zone: { type: 'enum', values: ['inner', 'outer'] } },
      },
      Build: {
        command: 'building.Build', ownVillage: true, needAuth: true,
        schema: {
          zone: { type: 'enum', values: ['inner', 'outer'] },
          kind: { type: 'string', minLen: 1, maxLen: 32 },
        },
      },
      UpgradeBuilding: {
        command: 'building.Upgrade', ownVillage: true, needAuth: true,
        schema: { slotId: { type: 'string', minLen: 1, maxLen: 32 } },
      },
      RepairBuilding: {
        command: 'building.Repair', ownVillage: true, needAuth: true,
        schema: { slotId: { type: 'string', minLen: 1, maxLen: 32 } },
      },
      DemolishBuilding: {
        command: 'building.Demolish', ownVillage: true, needAuth: true,
        schema: { slotId: { type: 'string', minLen: 1, maxLen: 32 } },
      },
    },
    eventPushMap: {
      'building.Built': 'BuildingBuilt',
      'building.Upgraded': 'BuildingUpgraded',
      'building.Repaired': 'BuildingRepaired',
      'building.Demolishing': 'BuildingDemolishing',
      'building.Demolished': 'BuildingDemolished',
      'building.BattleDamaged': 'BuildingBattleDamaged',
    },
    },
  {
    moduleName: 'combat',
    publicActions: {
      GetBattle: {
        command: 'combat.GetBattle', ownVillage: true, needAuth: true,
        schema: { targetId: { type: 'string', minLen: 1, maxLen: 64 } },
      },
    },
    eventPushMap: {
      'combat.BattleStarted': 'BattleStarted',
      'combat.BattleTick': 'BattleTick',
      'combat.BattleEnded': 'BattleEnded',
    },
    },
  {
    moduleName: 'diplomacy',
    publicActions: {
      GetRelation: {
        command: 'diplomacy.GetRelation', needAuth: true, injectPlayerId: true,
        schema: { targetPlayerId: { type: 'string', minLen: 1, maxLen: 64 } },
      },
    },
    eventPushMap: { 'diplomacy.Changed': 'DiplomacyChanged' },
    },
  {
    moduleName: 'economy',
    publicActions: {
      GetResources: { command: 'economy.GetResources', ownVillage: true, needAuth: true, schema: {} },
    },
    eventPushMap: {
      'economy.CropDeficit': 'CropDeficit',
    },
    },
  {
    moduleName: 'mercenary',
    publicActions: {
      GetMercCamp: { command: 'mercenary.GetCamp', ownVillage: true, needAuth: true, schema: {} },
      RefreshMercCamp: { command: 'mercenary.Refresh', ownVillage: true, needAuth: true, schema: {} },
      HireMerc: {
        command: 'mercenary.Hire', ownVillage: true, needAuth: true,
        schema: { code: { type: 'string', minLen: 1, maxLen: 32 } },
      },
    },
    eventPushMap: {
      'mercenary.CampUpdated': 'MercenaryCampUpdated',
    },
    },
  {
    moduleName: 'meta',
    publicActions: {
      GetGameConfig: { command: 'meta.GetGameConfig', schema: {} },
    },
    },
  {
    moduleName: 'military',
    publicActions: {
      GetArmy: { command: 'military.GetArmy', ownVillage: true, needAuth: true, schema: {} },
      SetRaidDefense: {
        command: 'military.SetRaidDefense', ownVillage: true, needAuth: true,
        schema: {
          enabled: { type: 'boolean' },
          troops: { type: 'record_int', maxKeys: 20, minVal: 0, maxVal: 100000 },
        },
      },
      TrainTroops: {
        command: 'military.TrainTroops', ownVillage: true, needAuth: true,
        schema: {
          slotId: { type: 'string', minLen: 1, maxLen: 32, optional: true },
          unit:  { type: 'string', minLen: 1, maxLen: 32 },
          count: { type: 'integer', min: 1, max: 10000 },
        },
      },
      CancelTraining: {
        command: 'military.CancelTraining', ownVillage: true, needAuth: true,
        schema: { slotId: { type: 'string', minLen: 1, maxLen: 32, optional: true } },
      },
      DisbandTroops: {
        command: 'military.DisbandTroops', ownVillage: true, needAuth: true,
        schema: { units: { type: 'record_int', maxKeys: 20, minVal: 1, maxVal: 100000 } },
      },
    },
    eventPushMap: {
      'military.TroopTrained': 'TroopTrained',
    },
    },
  {
    moduleName: 'movement',
    publicActions: {
      SendRaid: {
        command: 'movement.SendRaid', ownVillage: true, needAuth: true,
        schema: {
          targetId: { type: 'string', minLen: 1, maxLen: 64 },
          troops:   { type: 'record_int', maxKeys: 20, minVal: 1, maxVal: 100000 },
          treasures: { type: 'string_array', optional: true, maxItems: 10, minLen: 1, maxLen: 64 },
        },
      },
      SendAttack: {
        command: 'movement.SendAttack', ownVillage: true, needAuth: true,
        schema: {
          targetVillage: { type: 'string', minLen: 1, maxLen: 64 },
          troops:        { type: 'record_int', maxKeys: 20, minVal: 1, maxVal: 100000 },
          treasures: { type: 'string_array', optional: true, maxItems: 10, minLen: 1, maxLen: 64 },
          declareWar: { type: 'boolean', optional: true },
        },
      },
      SendScout: {
        command: 'movement.SendScout', ownVillage: true, needAuth: true,
        schema: {
          targetVillage: { type: 'string', optional: true, minLen: 1, maxLen: 64 },
          targetId: { type: 'string', optional: true, minLen: 1, maxLen: 64 },
          troops: { type: 'record_int', maxKeys: 20, minVal: 1, maxVal: 100000 },
          treasures: { type: 'string_array', optional: true, maxItems: 10, minLen: 1, maxLen: 64 },
          scoutType: { type: 'enum', optional: true, values: ['scout_resources', 'scout_buildings'] },
        },
      },
      SendVillageRaid: {
        command: 'movement.SendVillageRaid', ownVillage: true, needAuth: true,
        schema: {
          targetVillage: { type: 'string', minLen: 1, maxLen: 64 },
          troops: { type: 'record_int', maxKeys: 20, minVal: 1, maxVal: 100000 },
          treasures: { type: 'string_array', optional: true, maxItems: 10, minLen: 1, maxLen: 64 },
          declareWar: { type: 'boolean', optional: true },
        },
      },
      SendReinforce: {
        command: 'movement.SendReinforce', ownVillage: true, needAuth: true,
        schema: {
          targetVillage: { type: 'string', minLen: 1, maxLen: 64 },
          troops: { type: 'record_int', maxKeys: 20, minVal: 1, maxVal: 100000 },
          treasures: { type: 'string_array', optional: true, maxItems: 10, minLen: 1, maxLen: 64 },
        },
      },
      GetMarchOptions: {
        command: 'movement.GetMarchOptions', ownVillage: true, needAuth: true,
        schema: { q: { type: 'integer', min: -100, max: 100 }, r: { type: 'integer', min: -100, max: 100 }, kind: { type: 'string', minLen: 1, maxLen: 16 }, refId: { type: 'string', optional: true, minLen: 1, maxLen: 64 } },
      },
      PreviewMarch: {
        command: 'movement.PreviewMarch', ownVillage: true, needAuth: true,
        schema: { q: { type: 'integer', min: -100, max: 100 }, r: { type: 'integer', min: -100, max: 100 }, mode: { type: 'enum', values: ['garrison', 'explore', 'transfer', 'reinforce', 'raid', 'attack', 'scout', 'ambush'] }, targetVillage: { type: 'string', optional: true, minLen: 1, maxLen: 64 }, troops: { type: 'record_int', maxKeys: 20, minVal: 1, maxVal: 100000 } },
      },
      FoundVillage: {
        command: 'movement.FoundVillage', ownVillage: true, needAuth: true,
        schema: {
          q: { type: 'integer', min: -100, max: 100 },
          r: { type: 'integer', min: -100, max: 100 },
        },
      },
      SendTransport: {
        command: 'movement.SendTransport', ownVillage: true, needAuth: true,
        schema: {
          targetVillage: { type: 'string', minLen: 1, maxLen: 64 },
          troops:        { type: 'record_int', maxKeys: 20, minVal: 1, maxVal: 100000 },
          cargo: { type: 'record_int', maxKeys: 4, minVal: 0, maxVal: 10_000_000 },
          treasures: { type: 'string_array', optional: true, maxItems: 10, minLen: 1, maxLen: 64 },
          mode: { type: 'enum', optional: true, values: ['transfer', 'transport', 'reinforce'] },
        },
      },
      SendGarrison: {
        command: 'movement.SendGarrison', ownVillage: true, needAuth: true,
        schema: {
          q: { type: 'integer', min: -100, max: 100 },
          r: { type: 'integer', min: -100, max: 100 },
          troops: { type: 'record_int', maxKeys: 20, minVal: 1, maxVal: 100000 },
          treasures: { type: 'string_array', optional: true, maxItems: 10, minLen: 1, maxLen: 64 },
        },
      },
      SendAmbush: {
        command: 'movement.SendAmbush', ownVillage: true, needAuth: true,
        schema: {
          q: { type: 'integer', min: -100, max: 100 },
          r: { type: 'integer', min: -100, max: 100 },
          troops: { type: 'record_int', maxKeys: 20, minVal: 1, maxVal: 100000 },
          treasures: { type: 'string_array', optional: true, maxItems: 10, minLen: 1, maxLen: 64 },
        },
      },
      SendExplore: {
        command: 'movement.SendExplore', ownVillage: true, needAuth: true,
        schema: {
          q: { type: 'integer', min: -100, max: 100 },
          r: { type: 'integer', min: -100, max: 100 },
          troops: { type: 'record_int', maxKeys: 20, minVal: 1, maxVal: 100000 },
          treasures: { type: 'string_array', optional: true, maxItems: 10, minLen: 1, maxLen: 64 },
        },
      },
      SendAutoExplore: {
        command: 'movement.SendAutoExplore', ownVillage: true, needAuth: true,
        schema: {
          q: { type: 'integer', min: -100, max: 100 },
          r: { type: 'integer', min: -100, max: 100 },
          troops: { type: 'record_int', maxKeys: 20, minVal: 1, maxVal: 100000 },
          treasures: { type: 'string_array', optional: true, maxItems: 10, minLen: 1, maxLen: 64 },
        },
      },
      StopMarch: {
        command: 'movement.StopMarch', ownVillage: true, needAuth: true,
        schema: { movementId: { type: 'string', minLen: 1, maxLen: 64 } },
      },
      ResumeMarch: {
        command: 'movement.ResumeMarch', ownVillage: true, needAuth: true,
        schema: { movementId: { type: 'string', minLen: 1, maxLen: 64 } },
      },
      RecallGarrison: {
        command: 'movement.RecallGarrison', ownVillage: true, needAuth: true,
        schema: { movementId: { type: 'string', minLen: 1, maxLen: 64 } },
      },
      RecallMarch: {
        command: 'movement.RecallMarch', ownVillage: true, needAuth: true,
        schema: { movementId: { type: 'string', minLen: 1, maxLen: 64 } },
      },
      ContinueGarrison: {
        command: 'movement.ContinueGarrison', ownVillage: true, needAuth: true,
        schema: {
          movementId: { type: 'string', minLen: 1, maxLen: 64 },
          q: { type: 'integer', min: -100, max: 100 },
          r: { type: 'integer', min: -100, max: 100 },
          mode: { type: 'enum', values: ['garrison', 'explore', 'raid', 'attack', 'scout', 'reinforce', 'transfer', 'ambush'] },
          targetId: { type: 'string', optional: true, minLen: 1, maxLen: 64 },
          targetVillage: { type: 'string', optional: true, minLen: 1, maxLen: 64 },
        },
      },
      ListMovements: { command: 'movement.List', ownVillage: true, needAuth: true, schema: {} },
      ListForeign: { command: 'movement.ListForeign', needAuth: true, injectPlayerId: true, schema: {} },
    },
    eventPushMap: {
      'movement.Sent': 'MarchSent',
      'movement.IncomingAttack': 'IncomingAttack',
      'movement.Returned': 'MarchReturned',
      'movement.Intercepted': 'MarchIntercepted',
      'movement.VillageFounded': 'VillageFounded',
      'movement.Garrisoned': 'Garrisoned',
      'movement.GarrisonRecalled': 'GarrisonRecalled',
      'movement.Explored': 'Explored',
      'movement.AutoExploreStopped': 'AutoExploreStopped',
      'movement.ScoutReport': 'ScoutReport',
      'movement.VisionUpdated': 'VisionUpdated',
      'movement.Recalled': 'MarchRecalled',
      'movement.Stopped': 'MarchStopped',
      'movement.Resumed': 'MarchResumed',
      'movement.Stepped': 'MarchStep',
      'movement.Removed': 'MarchRemoved',
      'movement.ForeignStepped': 'ForeignArmyStep',
      'movement.ForeignRemoved': 'ForeignArmyRemoved',
    },
    },
  {
    moduleName: 'notifications',
    publicActions: {
      GetNotifications: { command: 'notifications.List', ownVillage: true, needAuth: true, schema: {} },
    },
    eventPushMap: {},
    },
  {
    moduleName: 'player',
    publicActions: {
      Register: {
        command: 'player.Register',
        schema: {
          name:     { type: 'string', minLen: 1, maxLen: 16 },
          password: { type: 'string', minLen: 4, maxLen: 64 },
          tribe:    { type: 'enum', optional: true, values: ['romans', 'gauls', 'teutons'] },
        },
      },
      Login: {
        command: 'player.Login',
        schema: {
          name:     { type: 'string', minLen: 1, maxLen: 64 },
          password: { type: 'string', minLen: 1, maxLen: 64 },
        },
      },
      ResumeSession: {
        command: 'player.ResumeSession',
        schema: {
          token: { type: 'string', minLen: 1, maxLen: 256 },
          currentVillageId: { type: 'string', optional: true, minLen: 1, maxLen: 64 },
        },
      },
      SelectVillage: {
        command: 'player.SelectVillage',
        needAuth: true,
        injectPlayerId: true,
        schema: {
          villageId: { type: 'string', minLen: 1, maxLen: 64 },
        },
      },
      RenameVillage: {
        command: 'player.RenameVillage',
        needAuth: true,
        injectPlayerId: true,
        schema: {
          villageId: { type: 'string', minLen: 1, maxLen: 64 },
          name: { type: 'string', minLen: 1, maxLen: 24 },
        },
      },
    },
    eventPushMap: { 'player.VillageRenamed': 'VillageRenamed' },
    },
  {
    moduleName: 'population',
    publicActions: {
      GetPopulation: { command: 'population.GetSnapshot', ownVillage: true, needAuth: true, schema: {} },
    },
    eventPushMap: {
      'population.Changed': 'PopulationChanged',
    },
    },
  {
    moduleName: 'reputation',
    publicActions: {
      GetReputation: { command: 'reputation.GetByVillage', ownVillage: true, needAuth: true, schema: {} },
    },
    eventPushMap: { 'reputation.Changed': 'ReputationChanged' },
    },
  {
    moduleName: 'pve',
    publicActions: {
      GetTarget: {
        command: 'pve.GetTarget', needAuth: true,
        schema: { id: { type: 'string', minLen: 1, maxLen: 64 } },
      },
    },
    },
  {
    moduleName: 'research',
    publicActions: {
      GetState: { command: 'research.GetState', ownVillage: true, needAuth: true, schema: {} },
      GetTechTree: { command: 'research.GetTechTree', ownVillage: true, needAuth: true, schema: {} },
      StartResearch: { command: 'research.StartResearch', ownVillage: true, needAuth: true, schema: { techCode: { type: 'string', minLen: 1, maxLen: 32 } } },
      CancelResearch: { command: 'research.CancelResearch', ownVillage: true, needAuth: true, schema: {} },
    },
    // 左=内部事件名，右=推给客户端的事件名。右侧一律用**不带模块前缀**的裸名，
    // 与其它模块保持一致（military 推 TroopTrained、building 推 BuildingBuilt…），
    // 客户端的 notificationText / notificationKind 也是按裸名分派的。
    eventPushMap: {
      'research.TechCompleted': 'TechCompleted',
      'research.RpChanged': 'RpChanged',
    },
    },
  {
    moduleName: 'task',
    publicActions: {
      'task.GetState': { command: 'task.GetState', ownVillage: true, needAuth: true, schema: {} },
      'task.GetPlayerState': { command: 'task.GetPlayerState', needAuth: true, injectPlayerId: true, schema: {} },
      'task.Accept': { command: 'task.Accept', ownVillage: true, needAuth: true, schema: { code: { type: 'string', minLen: 1, maxLen: 32 } } },
      'task.Abandon': { command: 'task.Abandon', ownVillage: true, needAuth: true, schema: { code: { type: 'string', minLen: 1, maxLen: 32 } } },
      'task.SubmitResources': {
        command: 'task.SubmitResources', ownVillage: true, needAuth: true,
        schema: {
          code: { type: 'string', minLen: 1, maxLen: 32 },
          resources: { type: 'record_int', minVal: 0, maxVal: 2_000_000_000 },
        },
      },
      'task.Deliver': { command: 'task.Deliver', ownVillage: true, needAuth: true, schema: { code: { type: 'string', minLen: 1, maxLen: 32 } } },
    },
    // 左=内部事件名，右=推给客户端的裸名（与 research/tech 等保持一致）
    eventPushMap: {
      'task.ListChanged': 'TaskListChanged',
      'task.MapUpdated': 'TaskMapUpdated',
    },
    },
  {
    moduleName: 'trade',
    publicActions: {
      GetTradeCenter: { command: 'trade.GetCenter', ownVillage: true, needAuth: true, schema: {} },
      RefreshTrade: { command: 'trade.Refresh', ownVillage: true, needAuth: true, schema: {} },
      AcceptNpcOrder: {
        command: 'trade.AcceptNpc', ownVillage: true, needAuth: true,
        schema: { orderId: { type: 'string', minLen: 1, maxLen: 64 } },
      },
      // 购买 NPC 出售的宝物；宝物栏满时经 action 选择 替换(replace)/卖给NPC(sell)/放弃(discard)。
      AcceptNpcTreasure: {
        command: 'trade.AcceptNpcTreasure', ownVillage: true, needAuth: true,
        schema: {
          orderId: { type: 'string', minLen: 1, maxLen: 64 },
          action: { type: 'enum', values: ['store', 'replace', 'sell', 'discard'], optional: true },
          replaceCode: { type: 'string', minLen: 1, maxLen: 64, optional: true },
        },
      },
      CreateTradeOrder: {
        command: 'trade.CreateOrder', ownVillage: true, needAuth: true,
        schema: {
          give: { type: 'record_int', maxKeys: 5, minVal: 0, maxVal: 10_000_000 },
          want: { type: 'record_int', maxKeys: 5, minVal: 0, maxVal: 10_000_000 },
        },
      },
      AcceptPlayerOrder: {
        command: 'trade.AcceptPlayer', ownVillage: true, needAuth: true,
        schema: { orderId: { type: 'string', minLen: 1, maxLen: 64 } },
      },
      CancelTradeOrder: {
        command: 'trade.CancelOrder', ownVillage: true, needAuth: true,
        schema: { orderId: { type: 'string', minLen: 1, maxLen: 64 } },
      },
      // 「村民的请求」：玩家接受幸福村送达订单，把资源送往幸福村（单向商队）
      AcceptNpcDelivery: {
        command: 'trade.AcceptNpcDelivery', ownVillage: true, needAuth: true,
        schema: { orderId: { type: 'string', minLen: 1, maxLen: 64 } },
      },
      TransferResources: {
        command: 'trade.TransferResources', ownVillage: true, needAuth: true,
        schema: {
          targetVillage: { type: 'string', minLen: 1, maxLen: 64 },
          cargo: { type: 'record_int', maxKeys: 4, minVal: 0, maxVal: 10_000_000 },
        },
      },
    },
    eventPushMap: {
      'trade.CenterUpdated': 'TradeCenterUpdated',
    },
    },
  {
    moduleName: 'treasure',
    publicActions: {
      ListTreasures: { command: 'treasure.List', ownVillage: true, needAuth: true, schema: {} },
      // 使用宝物：仅对即时类(instantGold)有效，发放金币并移除；被动宝物返回 not_usable。
      UseTreasure: { command: 'treasure.Use', ownVillage: true, needAuth: true, schema: { code: { type: 'string', minLen: 1, maxLen: 64 }, location: { type: 'enum', optional: true, values: ['town', 'treasury', 'reserve'] } } },
      // 出售宝物：卖给 NPC 换金币(priceGold)并移除；被动/即时皆可。
      SellTreasure: { command: 'treasure.Sell', ownVillage: true, needAuth: true, schema: { code: { type: 'string', minLen: 1, maxLen: 64 }, location: { type: 'enum', optional: true, values: ['town', 'treasury', 'reserve'] } } },
      // 丢弃宝物：直接移除（不给金币），用于腾出宝物栏格子。
      DiscardTreasure: { command: 'treasure.Discard', ownVillage: true, needAuth: true, schema: { code: { type: 'string', minLen: 1, maxLen: 64 }, location: { type: 'enum', optional: true, values: ['town', 'treasury', 'reserve'] } } },
      UnloadTreasure: {
        command: 'treasure.Unload', ownVillage: true, needAuth: true,
        schema: {
          code: { type: 'string', minLen: 1, maxLen: 64 },
          from: { type: 'enum', values: ['town', 'treasury'] },
        },
      },
      LoadTreasure: {
        command: 'treasure.Load', ownVillage: true, needAuth: true,
        schema: { code: { type: 'string', minLen: 1, maxLen: 64 } },
      },
      // 确认领取待领取宝物（军队带回/送达 → 战报确认；超时由服务端自动遗弃）。
      // 收下(take)遇「已持有」「宝物栏已满」一律拒绝（玩家须显式 出售/遗弃）；出售(sell)需本村有贸易中心。
      ClaimPendingTreasure: {
        command: 'treasure.ClaimPending', ownVillage: true, needAuth: true,
        schema: {
          movementId: { type: 'string', minLen: 1, maxLen: 64 },
          decision: { type: 'enum', optional: true, values: ['take', 'sell', 'discard', 'release'] },
        },
      },
    },
    eventPushMap: {
      'treasure.Changed': 'TreasureChanged',
      'treasure.PendingDropped': 'TreasurePendingDropped',
      'treasure.PendingExpired': 'TreasurePendingExpired',
      'treasure.CarriedArrived': 'TreasureCarriedArrived',
      'treasure.DemolishRedistributed': 'TreasureDemolishRedistributed',
      'treasure.ReportCoords': 'TreasureReport',
    },
    },
  {
    moduleName: 'alchemy',
    publicActions: {
      GetAlchemy: { command: 'alchemy.Get', ownVillage: true, needAuth: true, schema: {} },
      SelectAlchemyTreasure: {
        command: 'alchemy.Select', ownVillage: true, needAuth: true,
        schema: {
          slot: { type: 'integer', min: 0, max: 2 },
          code: { type: 'string', minLen: 1, maxLen: 64 },
          location: { type: 'enum', values: ['town', 'treasury', 'reserve'] },
        },
      },
      StartAlchemy: { command: 'alchemy.Start', ownVillage: true, needAuth: true, schema: {} },
      ClaimAlchemy: { command: 'alchemy.Claim', ownVillage: true, needAuth: true, schema: {} },
    },
    eventPushMap: { 'alchemy.Updated': 'AlchemyUpdated' },
    },
  {
    moduleName: 'world',
    publicActions: {
      GetArea: {
        command: 'world.GetArea', needAuth: true, injectPlayerId: true,
        schema: {
          cq: { type: 'integer', min: -200, max: 200 },
          cr: { type: 'integer', min: -200, max: 200 },
          r:  { type: 'integer', min: 0, max: 50 },
          full: { type: 'boolean', optional: true },
        },
      },
    },
    },
];
