/**
 * task owner 对玩家归属信息的只读镜像。
 *
 * task 不读取 player / player_byvillage 集合；镜像只由 player.* Command 的公开快照
 * 补充。同步方法供既有任务规则在一次命令处理内查询，入口会先刷新相关玩家，
 * 因此不改变已有任务的 global/village scope 语义。
 */
import type { CommandBus } from '../../infra/command-bus.js';

interface VillageRow {
  id: string;
  name?: string;
}

interface PlayerRow {
  id: string;
  villages: VillageRow[];
}

export class TaskPlayerDirectory {
  private readonly players = new Map<string, PlayerRow>();
  private readonly ownerByVillage = new Map<string, string>();

  constructor(private readonly commands: CommandBus) {}

  villageOwner(villageId: string): string | null {
    return this.ownerByVillage.get(villageId) ?? null;
  }

  villages(playerId: string): string[] {
    return this.players.get(playerId)?.villages.map((village) => village.id) ?? [];
  }

  villageName(villageId: string): string {
    const owner = this.villageOwner(villageId);
    const village = owner ? this.players.get(owner)?.villages.find((item) => item.id === villageId) : undefined;
    return village?.name || villageId;
  }

  async refreshVillage(villageId: string): Promise<void> {
    if (!villageId) return;
    const result = await this.commands.send({ name: 'player.GetByVillage', from: 'task', payload: { villageId } });
    if (result.ok) this.remember((result.payload as { player?: unknown }).player);
  }

  async refreshPlayer(playerId: string): Promise<void> {
    if (!playerId) return;
    const result = await this.commands.send({ name: 'player.Get', from: 'task', payload: { playerId } });
    if (result.ok) this.remember((result.payload as { player?: unknown }).player);
  }

  async refreshAll(): Promise<void> {
    const result = await this.commands.send({ name: 'player.ListAll', from: 'task', payload: {} });
    if (!result.ok) return;
    const players = (result.payload as { players?: unknown[] }).players ?? [];
    for (const player of players) this.remember(player);
  }

  private remember(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const player = raw as { id?: unknown; villages?: unknown };
    if (typeof player.id !== 'string' || !Array.isArray(player.villages)) return;
    const villages = player.villages.flatMap((rawVillage): VillageRow[] => {
      if (!rawVillage || typeof rawVillage !== 'object') return [];
      const village = rawVillage as { id?: unknown; name?: unknown };
      if (typeof village.id !== 'string') return [];
      return [{ id: village.id, name: typeof village.name === 'string' ? village.name : undefined }];
    });
    const old = this.players.get(player.id);
    for (const village of old?.villages ?? []) this.ownerByVillage.delete(village.id);
    this.players.set(player.id, { id: player.id, villages });
    for (const village of villages) this.ownerByVillage.set(village.id, player.id);
  }
}
