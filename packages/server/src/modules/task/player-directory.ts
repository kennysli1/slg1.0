/**
 * task owner 对玩家归属信息的只读镜像。
 *
 * task 不读取 player / player_byvillage 集合；镜像只由 player.* Command 的公开快照
 * 和 kingdom.GetFief 这类窄用途只读命令补充。同步方法供既有任务规则在一次命令处理
 * 内查询，入口会先刷新相关玩家，因此不改变已有任务的 global/village scope 语义。
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

export interface DialogueContext {
  villageName: string;
  fiefName: string;
}

export class TaskPlayerDirectory {
  private readonly players = new Map<string, PlayerRow>();
  private readonly ownerByVillage = new Map<string, string>();
  private readonly fiefByVillage = new Map<string, string>();
  private readonly fiefLoading = new Map<string, Promise<string>>();

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

  fiefName(villageId: string): string {
    return this.fiefByVillage.get(villageId) ?? '当前封地';
  }

  /**
   * 任务只需要封地显示名，不应读取 kingdom 集合；通过 kingdom 的只读命令
   * 获取并缓存，避免把王国归属复制进玩家镜像或任务存档。
   */
  async refreshFief(villageId: string): Promise<string> {
    if (!villageId) return '当前封地';
    if (!this.villageOwner(villageId)) await this.refreshVillage(villageId);
    const owner = this.villageOwner(villageId);
    if (!owner) return '当前封地';
    const cached = this.fiefName(villageId);
    if (cached !== '当前封地') return cached;
    const pending = this.fiefLoading.get(owner);
    if (pending) return pending;
    const loading = (async () => {
      const result = await this.commands.send({ name: 'kingdom.GetFief', from: 'task', payload: { playerId: owner } });
      if (!result.ok) return cached;
      const fiefName = String((result.payload as { fiefName?: unknown }).fiefName ?? '').trim();
      if (!fiefName) return cached;
      for (const id of this.villages(owner)) this.fiefByVillage.set(id, fiefName);
      return fiefName;
    })();
    this.fiefLoading.set(owner, loading);
    try {
      return await loading;
    } finally {
      this.fiefLoading.delete(owner);
    }
  }

  async dialogueContext(villageId: string): Promise<DialogueContext> {
    await this.refreshFief(villageId);
    return { villageName: this.villageName(villageId), fiefName: this.fiefName(villageId) };
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
    for (const village of old?.villages ?? []) {
      this.ownerByVillage.delete(village.id);
      this.fiefByVillage.delete(village.id);
    }
    this.players.set(player.id, { id: player.id, villages });
    for (const village of villages) this.ownerByVillage.set(village.id, player.id);
  }
}
