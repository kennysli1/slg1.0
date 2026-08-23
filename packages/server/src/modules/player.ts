import type { Command, CommandResult } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { GameConfig } from '../infra/config.js';
import type { KeyedSerialQueue } from '../infra/keyed-serial-queue.js';
import { hexKey, hexDistanceWrapped, wrapHex } from '../infra/hex.js';
import { scrypt, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/**
 * 领域模块 · Player（玩家身份）
 * 多人化与上线的核心：玩家账号（用户名+密码）、种族、拥有的村庄列表。
 *
 * 职责：玩家账号的 owner。注册/登录、多村归属、主城标记、切村校验、
 *       玩家↔村庄双向映射、为新玩家分配地图空位。
 *
 * 扩展点：分城（AttachVillage / DetachVillage）、放弃分城等。
 */

export interface OwnedVillage {
  id: string;
  q: number;
  r: number;
  name: string;
  /** 建成时刻(ms)，放弃锁用；旧档缺省视为 0（可弃） */
  foundedAt?: number;
}

interface PlayerState {
  id: string;
  name: string;
  /** 密码哈希：salt:hash（hex） */
  pwd: string;
  /** 种族：romans/gauls/teutons */
  tribe: string;
  /** 主城 id（不可放弃） */
  capitalVillageId: string;
  /** 拥有的全部村庄（含主城） */
  ownedVillages: OwnedVillage[];
  /**
   * 兼容旧字段：始终等于 capitalVillageId。
   * 会话「当前操作村」由 Gateway session.villageId 持有，不存这里。
   */
  villageId: string;
  /** 主城坐标快照（兼容 Me.q/r） */
  q: number;
  r: number;
  createdAt: number;
  pvpHits?: number[];
  lastRecoveryAt?: number;
  pvpHitsByVillage?: Record<string, number[]>;
  lastRecoveryAtByVillage?: Record<string, number>;
}

/** 读档时可能只有旧单村字段。 */
type RawPlayer = Partial<PlayerState> & {
  id: string;
  name: string;
  pwd: string;
  tribe: string;
  createdAt: number;
  villageId?: string;
  q?: number;
  r?: number;
};

const COLLECTION = 'player';
const COLLECTION_BYNAME = 'player_byname';
const COLLECTION_BYVILLAGE = 'player_byvillage';

const VALID_TRIBES = ['romans', 'gauls', 'teutons'];
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function hashPassword(pwd: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pwd, salt, 32) as Buffer;
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(pwd: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const hash = await scryptAsync(pwd, Buffer.from(saltHex, 'hex'), 32) as Buffer;
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

/**
 * 无需新增存档的持久会话：账号密码哈希同时充当每个账号独立的签名密钥。
 * 将来改密码后，所有旧会话会自然失效。
 */
function signSession(playerId: string, expiresAt: number, passwordHash: string): string {
  const body = `${playerId}.${expiresAt}`;
  const mac = createHmac('sha256', passwordHash).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function validSessionToken(token: string, p: PlayerState, now: number): boolean {
  const [playerId, expiresRaw, suppliedMac, extra] = token.split('.');
  if (extra !== undefined || playerId !== p.id || !expiresRaw || !suppliedMac) return false;
  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  const expectedMac = createHmac('sha256', p.pwd).update(`${playerId}.${expiresAt}`).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(suppliedMac, 'base64url'); } catch { return false; }
  return supplied.length === expectedMac.length && timingSafeEqual(supplied, expectedMac);
}

export class PlayerModule {
  static readonly NAME = 'player';



  /** 放弃分城时由 app 注入的清理回调（清进度/地图/行军）。 */
  private wipeVillage?: (villageId: string) => void;
  /** 放弃锁秒数（来自常量，app 注入；默认 86400）。 */
  private abandonLockSec = 86400;

  constructor(
    private store: Store,
    private _bus: EventBus,
    private commands: CommandBus,
    private now: () => number,
    private config: GameConfig,
    /** 由 app 提供：实际创建一个村庄（拼装 economy/building/military/population + 放地图）。 */
    private createVillage: (villageId: string, q: number, r: number, name: string, tribe: string, initialPop?: number) => void | Promise<void>,
    /** 环绕平行四边形世界尺寸（axial q 周期 W、r 周期 H），用于随机分配出生坐标。 */
    private worldW: number = 41,
    private worldH: number = 41,
    /**
     * 全局共享串行队列（可选）。
     * Register 命令用 "account:<normalizedName>" 车道串行化，防止同名并发注册 TOCTOU。
     */
    private serialQueue?: KeyedSerialQueue,
    /**
     * 注入：返回所有"非空"地块坐标 key（含 pve/taskcamp/临时 PvE/玩家村），
     * 与 world.PlaceVillage 的占用口径一致。allocateSpot 复用，避免随机抽到被占用的格子。
     */
    private getOccupiedTiles?: () => Set<string>,
  ) {}

  setConfig(config: GameConfig): void {
    this.config = config;
    // 出生点分配缓存世界尺寸；GM 热重载后新注册玩家必须使用新的尺寸。
    this.worldW = config.constants.worldW ?? 41;
    this.worldH = config.constants.worldH ?? 41;
  }

  /** app 在组装后注入：清理单村进度与地图。 */
  setVillageWiper(fn: (villageId: string) => void, abandonLockSec?: number): void {
    this.wipeVillage = fn;
    if (abandonLockSec !== undefined) this.abandonLockSec = abandonLockSec;
  }

  init(): void {
    this.normalizeCoords();
    this.commands.register('player.Register', (c) => this.register(c));
    this.commands.register('player.Login', (c) => this.login(c));
    this.commands.register('player.ResumeSession', (c) => this.resumeSession(c));
    this.commands.register('player.Get', (c) => this.get(c));
    this.commands.register('player.GetByVillage', (c) => this.getByVillage(c));
    this.commands.register('player.SelectVillage', (c) => this.selectVillage(c));
    this.commands.register('player.RenameVillage', (c) => this.renameVillage(c));
    this.commands.register('player.AbandonVillage', (c) => this.abandonVillage(c));
    this.commands.register('player.AttachVillage', (c) => this.attachVillage(c));
    this.commands.register('player.DetachVillage', (c) => this.detachVillage(c));
    this.commands.register('player.AllocVillageId', (c) => this.allocVillageId(c));
    this.commands.register('player.CreateOwnedVillage', (c) => this.createOwnedVillage(c));
    this.commands.register('player.GetPvpContext', (c) => this.getPvpContext(c));
    this.commands.register('player.RecordPvpHit', (c) => this.recordPvpHit(c));
    this.commands.register('player.ListAll', (c) => this.listAll(c));
  }

  /** 规范化旧档 → 完整 PlayerState；若发生迁移则写回。 */
  private normalize(raw: RawPlayer): PlayerState {
    let changed = false;
    let capitalVillageId = raw.capitalVillageId;
    let ownedVillages = raw.ownedVillages ? [...raw.ownedVillages] : undefined;
    let villageId = raw.villageId;
    let q = raw.q ?? 0;
    let r = raw.r ?? 0;

    if (!ownedVillages || ownedVillages.length === 0) {
      const id = villageId ?? `v-${raw.id}`;
      ownedVillages = [{ id, q, r, name: `${raw.name}的村庄` }];
      capitalVillageId = id;
      villageId = id;
      changed = true;
    }
    if (!capitalVillageId) {
      capitalVillageId = ownedVillages[0]!.id;
      changed = true;
    }
    // 保证 capital 在列表中
    if (!ownedVillages.some((v) => v.id === capitalVillageId)) {
      ownedVillages.unshift({ id: capitalVillageId, q, r, name: `${raw.name}的村庄` });
      changed = true;
    }
    // 兼容字段对齐主城
    const capital = ownedVillages.find((v) => v.id === capitalVillageId)!;
    if (villageId !== capitalVillageId || q !== capital.q || r !== capital.r) {
      villageId = capitalVillageId;
      q = capital.q;
      r = capital.r;
      changed = true;
    }

    const p: PlayerState = {
      id: raw.id,
      name: raw.name,
      pwd: raw.pwd,
      tribe: raw.tribe,
      capitalVillageId,
      ownedVillages,
      villageId: capitalVillageId,
      q,
      r,
      createdAt: raw.createdAt,
      pvpHits: raw.pvpHits,
      lastRecoveryAt: raw.lastRecoveryAt,
      pvpHitsByVillage: raw.pvpHitsByVillage,
      lastRecoveryAtByVillage: raw.lastRecoveryAtByVillage,
    };
    if (changed) this.store.set(COLLECTION, p.id, p);
    return p;
  }

  private load(id: string): PlayerState | undefined {
    const raw = this.store.get<RawPlayer>(COLLECTION, id);
    if (!raw) return undefined;
    return this.normalize(raw);
  }

  /** 注册：用户名唯一 + 密码 + 种族 → 创建玩家与主城。 */
  private async register(cmd: Command): Promise<CommandResult> {
    const { name, password, tribe } = cmd.payload as { name: string; password: string; tribe: string };
    const clean = (name ?? '').trim();
    if (!clean) return { ok: false, payload: {}, reason: 'empty_name' };
    if (clean.length > 16) return { ok: false, payload: {}, reason: 'name_too_long' };
    if (!password || password.length < 4) return { ok: false, payload: {}, reason: 'password_too_short' };

    const norm = clean.toLowerCase();
    const t = VALID_TRIBES.includes(tribe) ? tribe : 'romans';

    const doRegister = async (): Promise<CommandResult> => {
      if (this.store.get<string>(COLLECTION_BYNAME, clean)) {
        return { ok: false, payload: {}, reason: 'name_taken' };
      }

      const id = `p-${this.nextSeq()}`;
      const villageId = `v-${id}-1`;
      const vName = `${clean}的村庄`;
      const allocated = await this.commands.send({
        name: 'world.AllocateSpawn', from: PlayerModule.NAME,
        payload: { refId: villageId, name: vName },
      });
      if (!allocated.ok) {
        return { ok: false, payload: {}, reason: allocated.reason ?? 'world_capacity_exhausted' };
      }
      const { q, r } = allocated.payload as { q: number; r: number };

      try {
        await this.createVillage(villageId, q, r, vName, t);
      } catch (err) {
        await this.commands.send({
          name: 'world.ClearVillage', from: PlayerModule.NAME, payload: { refId: villageId },
        });
        console.error(`[Player] register: createVillage failed for "${clean}"`, err);
        return { ok: false, payload: {}, reason: 'village_creation_failed' };
      }

      const owned: OwnedVillage = { id: villageId, q, r, name: vName, foundedAt: this.now() };
      const p: PlayerState = {
        id, name: clean, pwd: await hashPassword(password), tribe: t,
        capitalVillageId: villageId,
        ownedVillages: [owned],
        villageId, q, r, createdAt: this.now(),
      };
      this.store.set(COLLECTION, id, p);
      this.store.set(COLLECTION_BYNAME, clean, id);
      this.store.set(COLLECTION_BYVILLAGE, villageId, id);
      return { ok: true, payload: this.authPayload(p) };
    };

    if (this.serialQueue) {
      return this.serialQueue.run(`account:${norm}`, doRegister);
    }
    return doRegister();
  }

  private async login(cmd: Command): Promise<CommandResult> {
    const { name, password } = cmd.payload as { name: string; password: string };
    const clean = (name ?? '').trim();
    const id = this.store.get<string>(COLLECTION_BYNAME, clean);
    if (!id) return { ok: false, payload: {}, reason: 'no_such_user' };
    const p = this.load(id);
    if (!p) return { ok: false, payload: {}, reason: 'no_such_user' };
    if (!await verifyPassword(password ?? '', p.pwd)) return { ok: false, payload: {}, reason: 'wrong_password' };
    return { ok: true, payload: this.authPayload(p) };
  }

  private resumeSession(cmd: Command): CommandResult {
    const { token, currentVillageId } = cmd.payload as { token: string; currentVillageId?: string };
    const playerId = token.split('.', 1)[0] ?? '';
    const p = this.load(playerId);
    if (!p || !validSessionToken(token, p, this.now())) {
      return { ok: false, payload: {}, reason: 'invalid_session' };
    }
    const current = currentVillageId && p.ownedVillages.some((v) => v.id === currentVillageId)
      ? currentVillageId
      : p.capitalVillageId;
    return { ok: true, payload: this.authPayload(p, current) };
  }

  private get(cmd: Command): CommandResult {
    const p = this.load((cmd.payload as any).playerId);
    if (!p) return { ok: false, payload: {}, reason: 'player_not_found' };
    return { ok: true, payload: { player: this.publicPlayer(p) } };
  }

  private getByVillage(cmd: Command): CommandResult {
    const pid = this.store.get<string>(COLLECTION_BYVILLAGE, (cmd.payload as any).villageId);
    if (!pid) return { ok: false, payload: {}, reason: 'owner_not_found' };
    const p = this.load(pid);
    if (!p) return { ok: false, payload: {}, reason: 'owner_not_found' };
    return { ok: true, payload: { player: this.publicPlayer(p) } };
  }

  /** 校验村属于该玩家；Gateway 据此切换 session.villageId。 */
  private selectVillage(cmd: Command): CommandResult {
    const { playerId, villageId } = cmd.payload as { playerId: string; villageId: string };
    const p = this.load(playerId);
    if (!p) return { ok: false, payload: {}, reason: 'player_not_found' };
    const v = p.ownedVillages.find((x) => x.id === villageId);
    if (!v) return { ok: false, payload: {}, reason: 'village_not_owned' };
    return {
      ok: true,
      payload: {
        player: this.publicPlayer(p, villageId),
        currentVillageId: villageId,
      },
    };
  }

  /** 修改玩家自己村庄的名称；地图地块由 World 通过事件同步，避免跨模块直接改状态。 */
  private async renameVillage(cmd: Command): Promise<CommandResult> {
    const { playerId, villageId, name } = cmd.payload as {
      playerId: string; villageId: string; name: string;
    };
    const p = this.load(playerId);
    if (!p) return { ok: false, payload: {}, reason: 'player_not_found' };
    const village = p.ownedVillages.find((v) => v.id === villageId);
    if (!village) return { ok: false, payload: {}, reason: 'village_not_owned' };
    const clean = String(name ?? '').trim();
    if (!clean) return { ok: false, payload: {}, reason: 'village_name_empty' };
    if ([...clean].length > 24) return { ok: false, payload: {}, reason: 'village_name_too_long' };
    if (village.name === clean) {
      return { ok: true, payload: { player: this.publicPlayer(p) } };
    }
    const previousName = village.name;
    village.name = clean;
    this.store.set(COLLECTION, p.id, p);
    await this._bus.emit({
      name: 'player.VillageRenamed',
      source: PlayerModule.NAME,
      ts: this.now(),
      // 通过玩家维度推送，保证地图/村庄列表的所有会话都能立即刷新名称。
      payload: { playerId: p.id, playerIds: [p.id], villageId, name: clean, previousName },
    });
    return { ok: true, payload: { player: this.publicPlayer(p) } };
  }

  /**
   * 内部：把已建好的村挂到玩家名下（found 到达后调用）。
   * payload: { playerId, villageId, q, r, name }
   */
  private attachVillage(cmd: Command): CommandResult {
    const { playerId, villageId, q, r, name } = cmd.payload as {
      playerId: string; villageId: string; q: number; r: number; name: string;
    };
    const p = this.load(playerId);
    if (!p) return { ok: false, payload: {}, reason: 'player_not_found' };
    if (p.ownedVillages.some((v) => v.id === villageId)) {
      return { ok: false, payload: {}, reason: 'village_already_owned' };
    }
    if (this.store.get<string>(COLLECTION_BYVILLAGE, villageId)) {
      return { ok: false, payload: {}, reason: 'village_id_taken' };
    }
    p.ownedVillages.push({ id: villageId, q, r, name, foundedAt: this.now() });
    this.store.set(COLLECTION, p.id, p);
    this.store.set(COLLECTION_BYVILLAGE, villageId, p.id);
    void this._bus.emit({ name: 'player.VillageAttached', source: PlayerModule.NAME, ts: this.now(), payload: { playerId: p.id, villageId } });
    return { ok: true, payload: { player: this.publicPlayer(p) } };
  }

  private getPvpContext(cmd: Command): CommandResult {
    const villageId = String((cmd.payload as any).villageId ?? '');
    const pid = this.store.get<string>(COLLECTION_BYVILLAGE, villageId);
    const p = pid ? this.load(pid) : undefined;
    if (!p) return { ok: false, payload: {}, reason: 'owner_not_found' };
    if (!p.ownedVillages.some((v) => v.id === villageId)) return { ok: false, payload: {}, reason: 'village_not_owned' };
    const lossShieldSec = Number(this.config.constants.raw.pvp_loss_shield_sec) || 14400;
    const cutoff = this.now() - lossShieldSec * 1000;
    p.pvpHitsByVillage ??= {};
    p.pvpHitsByVillage[villageId] = (p.pvpHitsByVillage[villageId] ?? []).filter((t) => t >= cutoff);
    this.store.set(COLLECTION, p.id, p);
    const hitMults = String(this.config.constants.raw.pvp_loss_shield_multipliers ?? '1|0.5|0.25|0').split('|').map(Number);
    const hitMult = hitMults[Math.min(hitMults.length - 1, p.pvpHitsByVillage[villageId].length)] ?? 0;
    const recoverySec = Number(this.config.constants.raw.pvp_recovery_cooldown_sec) || 86400;
    const lastRecoveryAt = p.lastRecoveryAtByVillage?.[villageId] ?? 0;
    return { ok: true, payload: { playerId: p.id, capitalVillageId: p.capitalVillageId, hitMult, recoveryAvailable: this.now() - lastRecoveryAt >= recoverySec * 1000 } };
  }

  private recordPvpHit(cmd: Command): CommandResult {
    const villageId = String((cmd.payload as any).villageId ?? '');
    const pid = this.store.get<string>(COLLECTION_BYVILLAGE, villageId);
    const p = pid ? this.load(pid) : undefined;
    if (!p) return { ok: false, payload: {}, reason: 'owner_not_found' };
    const cutoff = this.now() - (Number(this.config.constants.raw.pvp_loss_shield_sec) || 14400) * 1000;
    p.pvpHitsByVillage ??= {};
    p.pvpHitsByVillage[villageId] = (p.pvpHitsByVillage[villageId] ?? []).filter((t) => t >= cutoff);
    if ((cmd.payload as any).recordHit !== false) p.pvpHitsByVillage[villageId].push(this.now());
    p.lastRecoveryAtByVillage ??= {};
    const canRecover = this.now() - (p.lastRecoveryAtByVillage[villageId] ?? 0) >= (Number(this.config.constants.raw.pvp_recovery_cooldown_sec) || 86400) * 1000;
    if (canRecover && Boolean((cmd.payload as any).recovered)) p.lastRecoveryAtByVillage[villageId] = this.now();
    this.store.set(COLLECTION, p.id, p);
    return { ok: true, payload: { canRecover } };
  }

  /**
   * 放弃分城：非主城、过锁定期 → 卸归属 + 清理进度/地图。
   */
  private abandonVillage(cmd: Command): CommandResult {
    const { playerId, villageId } = cmd.payload as { playerId: string; villageId: string };
    const p = this.load(playerId);
    if (!p) return { ok: false, payload: {}, reason: 'player_not_found' };
    if (villageId === p.capitalVillageId) {
      return { ok: false, payload: {}, reason: 'cannot_abandon_capital' };
    }
    const v = p.ownedVillages.find((x) => x.id === villageId);
    if (!v) return { ok: false, payload: {}, reason: 'village_not_owned' };
    const foundedAt = v.foundedAt ?? 0;
    if (foundedAt > 0 && this.now() - foundedAt < this.abandonLockSec * 1000) {
      return { ok: false, payload: {}, reason: 'abandon_locked' };
    }
    if (!this.wipeVillage) {
      return { ok: false, payload: {}, reason: 'wipe_not_configured' };
    }
    // 先卸归属再清进度，避免 GetByVillage 残留
    const det = this.detachVillage({
      name: 'player.DetachVillage', from: PlayerModule.NAME,
      payload: { playerId, villageId },
    } as Command);
    if (!det.ok) return det;
    this.wipeVillage(villageId);
    return { ok: true, payload: { player: (det.payload as any).player, abandoned: villageId } };
  }

  /**
   * 内部：从玩家名下移除村（放弃分城后调用；不删主城）。
   * payload: { playerId, villageId }
   */
  private detachVillage(cmd: Command): CommandResult {
    const { playerId, villageId } = cmd.payload as { playerId: string; villageId: string };
    const p = this.load(playerId);
    if (!p) return { ok: false, payload: {}, reason: 'player_not_found' };
    if (villageId === p.capitalVillageId) {
      return { ok: false, payload: {}, reason: 'cannot_detach_capital' };
    }
    const idx = p.ownedVillages.findIndex((v) => v.id === villageId);
    if (idx < 0) return { ok: false, payload: {}, reason: 'village_not_owned' };
    p.ownedVillages.splice(idx, 1);
    this.store.set(COLLECTION, p.id, p);
    this.store.delete(COLLECTION_BYVILLAGE, villageId);
    return { ok: true, payload: { player: this.publicPlayer(p) } };
  }

  /**
   * 内部：分配 id + 建村装配 + 挂归属（拓荒到达成功时由 movement 调用）。
   * payload: { playerId, q, r, name? }
   */
  private async createOwnedVillage(cmd: Command): Promise<CommandResult> {
    const { playerId, q, r, name } = cmd.payload as {
      playerId: string; q: number; r: number; name?: string;
    };
    const p = this.load(playerId);
    if (!p) return { ok: false, payload: {}, reason: 'player_not_found' };

    const alloc = this.allocVillageId({
      name: 'player.AllocVillageId', from: PlayerModule.NAME, payload: { playerId },
    } as Command);
    if (!alloc.ok) return alloc;
    const villageId = (alloc.payload as { villageId: string }).villageId;
    const vName = (name && name.trim()) || `${p.name}的分城`;

    try {
      // 拓荒成功后新城以 5 名初始人口开局；人口模块仍负责计算硬上限。
      await this.createVillage(villageId, q, r, vName, p.tribe, 5);
    } catch (err) {
      console.error(`[Player] createOwnedVillage failed`, err);
      return { ok: false, payload: {}, reason: 'village_creation_failed' };
    }

    const att = this.attachVillage({
      name: 'player.AttachVillage', from: PlayerModule.NAME,
      payload: { playerId, villageId, q, r, name: vName },
    } as Command);
    if (!att.ok) return att;
    return {
      ok: true,
      payload: { villageId, player: (att.payload as any).player },
    };
  }

  /** 分配下一个村 id：v-<playerId>-<n>。 */
  private allocVillageId(cmd: Command): CommandResult {
    const { playerId } = cmd.payload as { playerId: string };
    const p = this.load(playerId);
    if (!p) return { ok: false, payload: {}, reason: 'player_not_found' };
    let n = p.ownedVillages.length + 1;
    let id = `v-${playerId}-${n}`;
    while (this.store.get<string>(COLLECTION_BYVILLAGE, id) || p.ownedVillages.some((v) => v.id === id)) {
      n += 1;
      id = `v-${playerId}-${n}`;
    }
    return { ok: true, payload: { villageId: id } };
  }

  /**
   * 对外安全字段。
   * villageId / q / r：默认主城；若传入 currentVillageId 则指向当前操作村（供 Select 响应）。
   */
  /** 返回所有玩家的 id + villages，供视野模块计算观察者（city vision）。 */
  private listAll(_cmd: Command): CommandResult {
    const players = this.store.all<PlayerState>(COLLECTION).map((p) => ({
      id: p.id,
      villages: p.ownedVillages.map((v) => ({ id: v.id, q: v.q, r: v.r, name: v.name })),
    }));
    return { ok: true, payload: { players } };
  }

  private publicPlayer(p: PlayerState, currentVillageId?: string) {
    const current = currentVillageId
      ?? p.capitalVillageId;
    const cur = p.ownedVillages.find((v) => v.id === current) ?? p.ownedVillages[0]!;
    return {
      id: p.id,
      name: p.name,
      tribe: p.tribe,
      villageId: cur.id,
      currentVillageId: cur.id,
      capitalVillageId: p.capitalVillageId,
      q: cur.q,
      r: cur.r,
      villages: p.ownedVillages.map((v) => ({
        id: v.id,
        q: v.q,
        r: v.r,
        name: v.name,
        isCapital: v.id === p.capitalVillageId,
      })),
    };
  }

  private authPayload(p: PlayerState, currentVillageId?: string) {
    return {
      player: this.publicPlayer(p, currentVillageId),
      sessionToken: signSession(p.id, this.now() + SESSION_TTL_MS, p.pwd),
    };
  }

  private nextSeq(): number {
    const n = (this.store.get<number>('player_seq', 'n') ?? 0) + 1;
    this.store.set('player_seq', 'n', n);
    return n;
  }

  /** 归一玩家坐标进环面 [0,W)×[0,H)（幂等，兼容旧六边形存档）。各模块在 init 自归一自己的集合。 */
  private normalizeCoords(): void {
    const W = this.worldW, H = this.worldH;
    for (const raw of this.store.all<RawPlayer>(COLLECTION)) {
      const upd: any = { ...raw };
      if (typeof raw.q === 'number' && typeof raw.r === 'number') {
        const w = wrapHex({ q: raw.q, r: raw.r }, W, H);
        upd.q = w.q; upd.r = w.r;
      }
      if (Array.isArray(raw.ownedVillages)) {
        upd.ownedVillages = raw.ownedVillages.map((v: any) => {
          const w = wrapHex({ q: v.q, r: v.r }, W, H);
          return { ...v, q: w.q, r: w.r };
        });
      }
      this.store.set(COLLECTION, raw.id, upd);
    }
  }

  /**
   * 为新玩家分配地图空位：在地图内随机散布，与现有**主城**保持最小间距。
   * 关键修正：空格子 = 该坐标在 world_tile 无记录或 kind==='empty'（pve/taskcamp/临时 PvE 都算"非空"）。
   * 选到非空格子时，随机换一个继续，**绝不报错放弃**；占用真相直接复用 world.getOccupiedTileKeys()，
   * 保证与 PlaceVillage 的口径（exist && exist.kind !== 'empty'）完全一致。
   */
  private allocateSpot(): { q: number; r: number } | null {
    const existing = this.store.all<RawPlayer>(COLLECTION).map((raw) => this.normalize(raw));
    // 玩家主城坐标（既有占用口径之一）
    const taken = new Set<string>();
    for (const p of existing) {
      for (const v of p.ownedVillages) taken.add(hexKey(v.q, v.r));
    }
    // 世界占用（pve / taskcamp / 临时 PvE / 资源点等），与 world.PlaceVillage 占用口径完全一致
    const occupied = this.getOccupiedTiles?.() ?? new Set<string>();

    const W = this.worldW, H = this.worldH;
    const MIN_SPACING = Math.max(3, Math.min(8, Math.floor(Math.min(W, H) / 4)));

    let seed = existing.length * 2654435761 + 1;
    const lcg = () => {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      return (seed >>> 0) / 0x100000000;
    };

    // 完全空格子的判定：既不在世界占用集合，也不在玩家主城集合，且与任何主城保持最小间距
    const isFree = (q: number, r: number): boolean => {
      const key = hexKey(q, r);
      if (occupied.has(key) || taken.has(key)) return false; // 世界占用 / 玩家主城 都不可
      return !existing.some((p) =>
        p.ownedVillages.some((v) => hexDistanceWrapped({ q, r }, { q: v.q, r: v.r }, W, H) < MIN_SPACING),
      );
    };

    // 随机散布：命中占用/过近就换一个继续，绝不报错放弃
    const MAX_ATTEMPTS = 400;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const q = Math.floor(lcg() * W);
      const r = Math.floor(lcg() * H);
      if (isFree(q, r)) return { q, r };
    }

    // 兜底：线性扫描第一个完全空格子（含世界占用与间距判定）
    for (let r = 0; r < H; r++) {
      for (let q = 0; q < W; q++) {
        if (isFree(q, r)) return { q, r };
      }
    }
    return null;
  }

  /**
   * 运维：为所有现存账号重建**主城**（刷档后调用）。多村进度已随 PROGRESS 清空，
   * 此处把玩家收束回单主城。
   */
  async rebuildVillages(reassignSpots: boolean): Promise<void> {
    const players = this.store
      .all<RawPlayer>(COLLECTION)
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((raw) => this.normalize(raw));

    this.store.clear(COLLECTION_BYVILLAGE);

    for (const p of players) {
      let q = p.q;
      let r = p.r;
      let villageId = `v-${p.id}-1`;
      if (reassignSpots) {
        const allocated = await this.commands.send({
          name: 'world.AllocateSpawn', from: PlayerModule.NAME,
          payload: { refId: villageId, name: `${p.name}的村庄` },
        });
        if (!allocated.ok) throw new Error(allocated.reason ?? 'world_capacity_exhausted');
        ({ q, r } = allocated.payload as { q: number; r: number });
      } else {
        // 保留原主城坐标；若旧 id 是 v-p-N 则升为 v-p-N-1
        const capital = p.ownedVillages.find((v) => v.id === p.capitalVillageId);
        if (capital) { q = capital.q; r = capital.r; }
      }
      const vName = `${p.name}的村庄`;
      if (!reassignSpots) {
        const restored = await this.commands.send({
          name: 'world.RestoreVillage', from: PlayerModule.NAME,
          payload: { q, r, refId: villageId, name: vName },
        });
        if (!restored.ok) throw new Error(restored.reason ?? 'village_restore_failed');
      }
      const owned: OwnedVillage = { id: villageId, q, r, name: vName };
      const updated: PlayerState = {
        ...p,
        capitalVillageId: villageId,
        ownedVillages: [owned],
        villageId,
        q,
        r,
      };
      this.store.set(COLLECTION, p.id, updated);
      this.store.set(COLLECTION_BYVILLAGE, villageId, p.id);
      await this.createVillage(villageId, q, r, vName, p.tribe);
    }
  }
}
