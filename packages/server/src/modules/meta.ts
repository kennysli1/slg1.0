import type { Command, CommandResult } from '@slg/shared';
import type { CommandBus } from '../infra/command-bus.js';
import type { GameConfig } from '../infra/config.js';
import type { ModuleManifest } from '../gateway/manifest.js';

/**
 * 领域模块 · Meta（对外配置下发）— 无状态
 * 对应 review1.0 §8.3：客户端不再依赖本地 info.ts 双源，渲染用的名称/图标/分类
 * 统一从服务端配置下发（单一真源 SSOT）。
 *
 * 只读 config，不持有状态、不改任何东西。返回"前端渲染最小集"派生快照：
 * 不暴露成本公式/内部 def 细节，只给展示需要的字段 + 前端白名单常量。
 */
export class MetaModule {
  static readonly NAME = 'meta';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'meta',
    publicActions: {
      GetGameConfig: { command: 'meta.GetGameConfig', schema: {} },
    },
  };

  constructor(
    private commands: CommandBus,
    private config: GameConfig,
  ) {}

  /** 热重载配置（改 CSV 后调用）。 */
  setConfig(config: GameConfig): void {
    this.config = config;
  }

  init(): void {
    this.commands.register('meta.GetGameConfig', (c) => this.getGameConfig(c));
  }

  /** 前端渲染最小集：名称/图标/分类 + 白名单常量。 */
  private getGameConfig(_cmd: Command): CommandResult {
    const c = this.config;
    return {
      ok: true,
      payload: {
        resources: c.resources.map((r) => ({ key: r.key, name: r.name, icon: r.icon })),
        buildings: Object.values(c.buildings).map((b) => ({
          kind: b.kind, name: b.name, icon: b.icon, zone: b.zone,
          resource: b.resource ?? null,
          desc: b.desc, effect: b.effect,
          popCapPerLevel: b.popCapPerLevel,
          // 每级人口增量（反映覆盖）：下标 i = 等级 (i+1) 的 popCap；用于升级卡显示「本次升级获得的人口」与详情累计求和。
          // 当 GM 通过 /gm/balance 把不同等级改成不同 popCap 时，旧字段 popCapPerLevel（=levels[1].popCap）不足以表达，故新增。
          popCapByLevel: Array.from({ length: b.maxLevel }, (_, i) => b.levels[i + 1]?.popCap ?? 0),
        })),
        units: Object.values(c.units).map((u) => ({
          key: u.key, tribe: u.tribe, name: u.name, icon: u.icon, form: u.form,
          popCost: u.popCost,
          upkeep: u.upkeep,
          isMercenary: !!u.isMercenary,
        })),
        // 雇佣兵单独下发（含完整战斗属性 + 金币单价），供招募店 UI 与军队详情展示
        mercenaries: Object.values(c.units).filter((u) => u.isMercenary).map((u) => ({
          key: u.key, name: u.name, icon: u.icon, form: u.form,
          meleeAtk: u.meleeAtk, rangedAtk: u.rangedAtk,
          meleeDef: u.meleeDef, rangedDef: u.rangedDef,
          speed: u.speed, carry: u.carry, goldCost: u.goldCost ?? 0,
          commandCost: u.commandCost ?? 1,
          contractSec: u.contractSec ?? 259200,
          tier: u.mercTier ?? 1,
        })),
        pveTemplates: Object.values(c.pveTemplates).map((p) => ({
          type: p.type, name: p.name, icon: p.icon,
        })),
        // 宝物目录：供贸易中心 NPC 售卖 / 战报拾取 / 宝物栏 UI 展示
        treasures: Object.values(c.treasures).map((t) => ({
          code: t.code, name: t.name, icon: t.icon,
          category: t.category, rarity: t.rarity,
          effectType: t.effectType, effectValue: t.effectValue,
          priceGold: t.priceGold, dropRate: t.dropRate, applyType: t.applyType,
          equipCategory: t.equipCategory,
          stackGroup: t.stackGroup,
          effectCap: t.effectCap,
          uniqueEffect: t.uniqueEffect,
        })),
        // 仅下发前端需要的白名单常量（不泄漏平衡参数）
        constants: {
          mapViewRadius: c.constants.mapViewRadius,
          mapSize: c.constants.mapSize,
          worldW: c.constants.worldW,
          worldH: c.constants.worldH,
          // 人口 v3（硬上限模型）展示/外插用常量：增长速率绑在城镇中心，由 main.popGrowthPerLevel × mainLevel 决定
          popGrowthPerLevel: c.buildings.main?.popGrowthPerLevel ?? 0,
          popProsperityFullRatio: c.constants.popProsperityFullRatio,
          popRaceMobilizeMax: c.constants.popRaceMobilizeMax,
          popLaborFloor: c.constants.popLaborFloor,
          popCropPerLabor: c.constants.popCropPerLabor,
          popHospitalRecoveryBase: c.constants.popHospitalRecoveryBase,
          popHospitalRecoveryPerLevel: c.constants.popHospitalRecoveryPerLevel,
          popHospitalRecoveryMax: c.constants.popHospitalRecoveryMax,
          smithyUpgradeSec: c.constants.smithyUpgradeSec,
          popFamineTickSec: c.constants.popFamineTickSec,
          // 金币经济展示/外插用常量
          goldTaxPerCivilianPerHour: c.constants.goldTaxPerCivilianPerHour,
          startGoldAmount: c.constants.startGoldAmount,
          // 建筑"功能/提供"展示用常量（客户端详情弹窗计算仓储上限/加成）
          storageBase: c.constants.storageBase,
          storageGrowthPerLevel: c.constants.storageGrowthPerLevel,
          smithyBonusPerLevel: c.constants.smithyBonusPerLevel,
          // 铁匠升级造价基数：客户端据此算出「木/泥各 base×目标等级」并显示精确消耗
          smithyCostBase: c.constants.smithyCostBase,
          wallBonusPerLevel: c.constants.wallBonusPerLevel,
          // 军事建筑训练提速/降费（建筑等级带来的收益，前端按等级展示固定减幅用）
          trainTimeReducePerLevel: c.constants.trainTimeReducePerLevel,
          trainTimeReduceCap: c.constants.trainTimeReduceCap,
          trainCostReducePerLevel: c.constants.trainCostReducePerLevel,
          trainCostReduceCap: c.constants.trainCostReduceCap,
          // 贸易中心：路线运力/商队速度/NPC 计价/挂单上限与存活时长
          tradeRouteCapacity: c.constants.tradeRouteCapacity,
          tradeCaravanSpeed: c.constants.tradeCaravanSpeed,
          tradeNpcGoldPerResource: c.constants.tradeNpcGoldPerResource,
          tradeNpcSellMargin: c.constants.tradeNpcSellMargin,
          tradeOrderMaxPerVillage: c.constants.tradeOrderMaxPerVillage,
          tradeOrderTtlSec: c.constants.tradeOrderTtlSec,
          // 军队携带宝物：携带上限换算（每多少兵力+1格）与格数硬上限
          treasureCarryTroopsPerSlot: c.constants.treasureCarryTroopsPerSlot,
          treasureCarryMaxSlots: c.constants.treasureCarryMaxSlots,
        },
      },
    };
  }
}
