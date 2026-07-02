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
      GetGameConfig: { command: 'meta.GetGameConfig' },
    },
  };

  constructor(
    private commands: CommandBus,
    private config: GameConfig,
  ) {}

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
        fields: Object.values(c.fields).map((f) => ({
          type: f.type, name: f.name, icon: f.icon, resource: f.resource,
        })),
        buildings: Object.values(c.buildings).map((b) => ({
          kind: b.kind, name: b.name, icon: b.icon,
        })),
        units: Object.values(c.units).map((u) => ({
          key: u.key, tribe: u.tribe, name: u.name, icon: u.icon, form: u.form,
        })),
        pveTemplates: Object.values(c.pveTemplates).map((p) => ({
          type: p.type, name: p.name, icon: p.icon,
        })),
        // 仅下发前端需要的白名单常量（不泄漏平衡参数）
        constants: {
          mapViewRadius: c.constants.mapViewRadius,
          mapSize: c.constants.mapSize,
        },
      },
    };
  }
}
