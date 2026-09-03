/**
 * 客户端单元测试（node:test + tsx）
 * 覆盖：escapeHtml/escapeAttr 转义函数 + errText 错误码翻译 + isCompatibleVersion 版本守卫
 *       + 人口系统 v3 硬上限：PopSnapshot 新字段 + PopulationChanged 事件文案
 *       + 战报分类 notificationKind（驱动报告页的图标与色带）。
 * 纯逻辑，无浏览器依赖，可在 Node 环境直接运行。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { escapeHtml, escapeAttr } from '../shared/utils/escape.js';
import { errText } from '../shared/ui/text.js';
import { isCompatibleVersion } from '../api.js';
import { WIRE_VERSION, WIRE_MIN_VERSION } from '@slg/shared';
import { setPopState, getPopState, interpolatePop, getCache, setCache, patchMovement, replaceMovementSnapshot, getReports, addReport, seedReports } from '../app/state.js';
import { beginVillageSwitch, endVillageSwitch, findTaskCampMarker, setPlayerTaskState, setTaskMarkers, setTaskState, taskMarkers, villageSwitching } from '../app/store.js';
import { breakdownTooltip, populationLedgerGrowth, populationTooltip, resourceLedgerRate } from '../features/village/VillageResourceLedger.js';
import { notificationText, notificationKind, isReportEvent } from '../features/reports/notification-text.js';
import { fmtDur, secLeft } from '../shared/utils/format.js';
import { modalLayerZ } from '../ui/modal-layer.js';
import { capitalCoordinate, currentVillageCoordinate, currentVillageName, parseMapCoordinate, pendingTaskCamps } from '../features/map/map-navigation.js';
import { buildLandmarkTriangleOutline, foreignArmyMarkerTone, landmarkCenterFromTile, mapEntityRingKind, normalizeIncomingWarningForRender, normalizeMapVillageRelation, shouldRenderMarchPath, shouldRenderTerrainFog, terrainDisplayName, terrainFromTile } from '../features/map/HexMap.js';
import { artPath } from '../ui/Icon.js';
import { readTaskMenuOpenState, taskMenuStorageKey, writeTaskMenuOpenState } from '../features/village/task-menu-state.js';
import { readVillageWorkbenchPreferences, toggleVillageWorkbench, villageWorkbenchLayoutClass, villageWorkbenchStorageKey, writeVillageWorkbenchPreferences } from '../features/village/workbench-preferences.js';
import { confirmOwnedVillage, inspectOwnedVillage } from '../features/map/owned-village-selection.js';
import { acceptReplyIntent, deliverReplyIntent, nextDialogueSegment, visibleDialogueSegments } from '../features/village/task-dialogue-flow.js';
import { toggleMultiSelection } from '../features/simulator/BattleSimulatorScreen.js';
import { unitCardBaseStats } from '../features/army/unit-card-stats.js';
import { isDiceMatchComplete, projectDiceQuestReplay, type DiceQuestReplayBase } from '../features/village/dice-quest-replay.js';

describe('军队面板折叠区顺序', () => {
  it('防御掠夺位于训练下方、解散上方，并使用与解散相同的折叠控件', () => {
    const source = readFileSync(new URL('../features/army/ArmyScreen.tsx', import.meta.url), 'utf8');
    const training = source.indexOf('<TrainingCenterSection />');
    const raidDefense = source.indexOf('<RaidDefenseSection army={army} />');
    const disband = source.indexOf('<DisbandSection army={army} />');
    assert.ok(training >= 0 && raidDefense > training && disband > raidDefense);
    assert.match(source, /<details class="army-collapsible-details raid-defense-details">/);
    assert.match(source, /<details class="army-collapsible-details disband-details">/);
    assert.match(source, /<summary class="section-head section-head--toggle">[\s\S]*?防御掠夺/);
  });
});

describe('骰子任务逐帧回放', () => {
  const base = (): DiceQuestReplayBase => ({
    playerScore: 200,
    aiScore: 300,
    turnScore: 0,
    turnBreakdown: [],
    dice: [],
    match: { playerWins: 0, npcWins: 0, winsRequired: 2 },
  });

  it('NPC 连续掷骰不会重置本轮累计，收下动作出现后才更新总分', () => {
    const firstDice = [{ id: 'a', value: 1 }, { id: 'b', value: 2 }];
    const secondDice = [{ id: 'c', value: 5 }];
    const events = [
      { kind: 'roll', side: 'ai' as const, dice: firstDice, message: 'NPC掷出了骰子' },
      { kind: 'keep', side: 'ai' as const, dice: firstDice, option: { dieIds: ['a'], score: 100, label: '1' }, turnScore: 100, message: '保留1' },
      { kind: 'roll', side: 'ai' as const, dice: secondDice, message: 'NPC掷出了骰子' },
      { kind: 'keep', side: 'ai' as const, dice: secondDice, option: { dieIds: ['c'], score: 50, label: '5' }, turnScore: 150, message: '保留5' },
      { kind: 'bank', side: 'ai' as const, dice: secondDice, points: 150, turnScore: 150, message: '收下150分' },
    ];
    const beforeBank = projectDiceQuestReplay(base(), events.slice(0, 4), false, { playerWins: 0, npcWins: 0, winsRequired: 2 });
    assert.equal(beforeBank.turnScore, 150);
    assert.equal(beforeBank.aiScore, 300, '总分不能在收下动作出现前提前更新');
    assert.deepEqual(beforeBank.turnBreakdown, [{ label: '1', score: 100 }, { label: '5', score: 50 }]);

    const banked = projectDiceQuestReplay(base(), events, false, { playerWins: 0, npcWins: 0, winsRequired: 2 });
    assert.equal(banked.turnScore, 150);
    assert.equal(banked.aiScore, 450);
  });

  it('爆骰文字出现前保留阶段分，红色爆骰帧出现后才归零', () => {
    const started = base();
    started.turnScore = 100;
    started.turnBreakdown = [{ label: '1', score: 100 }];
    started.dice = [{ id: 'old', value: 1 }];
    const bustDice = [{ id: 'new', value: 2 }];
    const events = [
      { kind: 'roll', side: 'player' as const, dice: bustDice, message: '你掷出了骰子' },
      { kind: 'bust', side: 'player' as const, dice: bustDice, points: 100, message: '爆骰' },
    ];
    const reveal = projectDiceQuestReplay(started, events, false, started.match);
    assert.equal(reveal.turnScore, 100);
    assert.deepEqual(reveal.turnBreakdown, [{ label: '1', score: 100 }]);
    assert.deepEqual(reveal.dice, bustDice);

    const alert = projectDiceQuestReplay(started, events, true, started.match);
    assert.equal(alert.turnScore, 0);
    assert.deepEqual(alert.turnBreakdown, []);
  });

  it('胜负事件出现时才更新多局比分', () => {
    const events = [{ kind: 'loss', side: 'ai' as const, message: '你放弃了本局对局' }];
    const view = projectDiceQuestReplay(base(), events, false, { playerWins: 0, npcWins: 1, winsRequired: 2 });
    assert.deepEqual(view.match, { playerWins: 0, npcWins: 1, winsRequired: 2 });
  });

  it('叠加放弃确认框不会因 close 回调变化而重新创建牌桌', () => {
    const source = readFileSync(new URL('../features/village/DiceQuestModal.tsx', import.meta.url), 'utf8');
    assert.match(source, /const closeRef = useRef\(close\)/);
    assert.match(source, /\}, \[task\.code\]\);/);
    assert.doesNotMatch(source, /\[task\.code,\s*close\]/);
  });

  it('放弃动作直接结束牌桌且前面阶段面板预留首条记录高度', () => {
    const source = readFileSync(new URL('../features/village/DiceQuestModal.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../styles/dice-quest.css', import.meta.url), 'utf8');
    assert.match(source, /if \(type === 'forfeit'\)[\s\S]*?setPlayback\(null\)[\s\S]*?return true;/);
    assert.match(styles, /\.dice-quest-breakdown \{[^}]*min-height:/);
  });

  it('小局结束显示下一局，大局结束只允许退出', () => {
    const match = { playerWins: 1, npcWins: 0, winsRequired: 2 };
    assert.equal(isDiceMatchComplete(match), false, '尚未达到两胜时应可开始下一局');
    assert.equal(isDiceMatchComplete({ ...match, playerWins: 2 }), true, '玩家两胜后整场结束');
    assert.equal(isDiceMatchComplete({ ...match, npcWins: 2 }), true, 'NPC两胜后整场结束');
    assert.equal(isDiceMatchComplete(match, { ready: true }), true, '服务端成功状态应视为整场结束');
    assert.equal(isDiceMatchComplete(match, { failureReady: true }), true, '服务端失败状态应视为整场结束');
    const source = readFileSync(new URL('../features/village/DiceQuestModal.tsx', import.meta.url), 'utf8');
    assert.match(source, /const matchComplete = isDiceMatchComplete\(displayedMatch, snapshot\?\.round\)/);
    assert.match(source, /'下一局'/);
  });
});

describe('兵种训练卡基础属性', () => {
  it('有宝物或科技最终加成时仍显示 CSV 基础攻防与速度', () => {
    assert.deepEqual(unitCardBaseStats({
      attack: 221, defense: 104, hp: 250, speed: 10,
      baseStats: { attack: 170, defense: 80, hp: 200, speed: 10 },
    }), { attack: 170, defense: 80, hp: 200, speed: 10 });
  });

  it('兼容尚未下发 baseStats 的旧服务端响应', () => {
    assert.deepEqual(unitCardBaseStats({
      attack: 75, defense: 42, hp: 120, speed: 6,
    }), { attack: 75, defense: 42, hp: 120, speed: 6 });
  });
});

describe('阶段化战斗模拟器的科技与宝物多选', () => {
  it('可连续选择多个项目，并点击已选项目取消；重复勾选不会产生重复项', () => {
    let selected = toggleMultiSelection([], 'tech-a', true);
    selected = toggleMultiSelection(selected, 'tech-b', true);
    assert.deepEqual(selected, ['tech-a', 'tech-b']);
    selected = toggleMultiSelection(selected, 'tech-a', false);
    assert.deepEqual(selected, ['tech-b']);
    assert.deepEqual(toggleMultiSelection(selected, 'tech-b', true), ['tech-b']);
  });
});

describe('联盟目录与战事目标交互', () => {
  it('失联联盟只显示公开目录，已有联盟成员目录不显示申请按钮', () => {
    const source = readFileSync(new URL('../features/alliance/AllianceScreen.tsx', import.meta.url), 'utf8');
    assert.match(source, /if \(alliance\.disconnected\) \{[\s\S]*?<DisconnectedAlliance/);
    assert.match(source, /DisconnectedAlliance[\s\S]*?onLeave=\{\(\) => action\('LeaveAlliance'/);
    assert.match(source, /pane === 'directory'[\s\S]*?canApply=\{false\}/);
    assert.match(source, /canApply && !a\.full \? <Btn/);
  });

  it('联盟战事按活跃优先、创建时间倒序，并让历史记录默认折叠', () => {
    const source = readFileSync(new URL('../features/alliance/AllianceScreen.tsx', import.meta.url), 'utf8');
    assert.match(source, /const sortedPlans = \[\.\.\.\(alliance\.warPlans \?\? \[\]\)\]\.sort/);
    assert.match(source, /if \(isActive\(a\) !== isActive\(b\)\) return isActive\(a\) \? -1 : 1/);
    assert.match(source, /<details ref=\{detailsRef\} class=\{`war-plan\$\{active \? ' war-plan--active' : ' war-plan--history'\}`\} open=\{active \|\| expanded\}/);
    assert.match(source, /const \[expanded, setExpanded\] = useState\(active\)/);
    assert.match(source, /useEffect\(\(\) => \{ setExpanded\(active\); \}, \[active\]\)/);
    assert.match(source, /deadline > now : plan\.status === 'open'/);
    assert.match(source, /detailsRef\.current\.open = active \|\| expanded/);
  });

  it('地图选目标后回到联盟页，并限制任务营地、普通 PvE 与盟友模式', () => {
    const app = readFileSync(new URL('../shell/App.tsx', import.meta.url), 'utf8');
    const alliance = readFileSync(new URL('../features/alliance/AllianceScreen.tsx', import.meta.url), 'utf8');
    assert.match(app, /allianceTargetPicker\.value = false;[\s\S]*?tab\.value = 'alliance'/);
    assert.match(app, /if \(target\.taskInfo && target\.taskInfo\.scope !== 'global'\)[\s\S]*?个人任务营地不能作为联盟战事目标/);
    assert.match(app, /allianceWarFocus\.value = true/);
    assert.match(alliance, /useState<Pane>\(\(\) => allianceWarFocus\.value \? 'war' : 'members'\)/);
    assert.match(alliance, /CancelAllianceWarParticipation/);
    assert.match(alliance, /const cancelAnchor = Number\(p\.joinDeadlineAt \?\? p\.deadlineAt\)/);
    assert.match(alliance, /now >= cancelAnchor/);
    assert.match(alliance, /now - cancelAnchor < 90_000/);
    assert.match(alliance, /war-treasure-picker/);
    assert.match(alliance, /treasureCarryCap\(troopCount\)/);
    assert.match(alliance, /treasures: selectedTreasures/);
    assert.match(alliance, /允许最大行军时间/);
    assert.match(alliance, /PreviewAllianceWarParticipation/);
    assert.match(alliance, /当前兵力预计行军/);
    assert.doesNotMatch(alliance, /若现在出发，预计/);
    assert.match(alliance, /withinLimit/);
    assert.match(alliance, /picked\?\.relation === 'allied' \? \['reinforce'\]/);
    assert.match(alliance, /picked\?\.cityState === true \? \['raid', 'attack'\] : \['raid'\]/);
    assert.match(alliance, /targetModeAllowed/);
  });
});

describe('任务接取与奖励领取对话状态机', () => {
  it('Accept 关闭不推进；离开关闭；只有首次接受任务才请求接取', () => {
    assert.equal(acceptReplyIntent('leave', false), 'close');
    assert.equal(acceptReplyIntent('accept', false), 'accept');
    assert.equal(acceptReplyIntent('accept', true), 'advance', '接取成功后的后续回复不得再次请求 Accept');
    assert.equal(nextDialogueSegment(0, 2), 1);
    assert.equal(nextDialogueSegment(1, 2), null);
  });

  it('Deliver 首次收下才结算，后续收下只推进，领取前异常回复不能跳过确认', () => {
    assert.equal(deliverReplyIntent('take', false), 'claim');
    assert.equal(deliverReplyIntent('take', true), 'advance');
    assert.equal(deliverReplyIntent('leave', false), 'close');
    assert.equal(deliverReplyIntent('continue', false), 'ignore');
  });

  it('空 NPC 文本但有收下回复的默认交付段仍可显示', () => {
    const segments = visibleDialogueSegments({
      segments: [{ npcName: '', npcText: '', replies: [{ key: 'take', label: '收下' }] }],
    });
    assert.equal(segments.length, 1);
    assert.equal(segments[0].replies?.[0].key, 'take');
  });

  it('组件接线保持关闭与推进分离，并由任务栏先请求 StartDeliver', () => {
    const taskBar = readFileSync(new URL('../features/village/TaskBar.tsx', import.meta.url), 'utf8');
    const autoHost = readFileSync(new URL('../features/village/TaskDialogueHost.tsx', import.meta.url), 'utf8');
    assert.match(taskBar, /function DialogueModal[\s\S]*onClose=\{closeSession\}/, 'Accept 的 X/Esc/遮罩只能关闭 session');
    assert.match(taskBar, /req\('task\.StartDeliver'/, '任务栏必须先请求奖励预览');
    assert.match(taskBar, /deliveryInFlight\.current = true[\s\S]*req\('task\.Deliver'/,
      '只有首次收下进入互斥后才能正式 Deliver');
    assert.match(autoHost, /onClose=\{closeSession\}/, '自动对话关闭不能调用段落推进');
    assert.match(autoHost, /req\('task\.ConsumeDialogue'/, '自动对话关闭必须消费整个等待 session');
  });
});

describe('王国地标中心标记', () => {
  it('只接受服务端显式中心，缺字段不会把每个占地格当成中心', () => {
    assert.equal(landmarkCenterFromTile('kingdom-fief-sw', true), true);
    assert.equal(landmarkCenterFromTile('kingdom-fief-sw', false), false);
    assert.equal(landmarkCenterFromTile('kingdom-fief-sw', undefined), false);
    assert.equal(landmarkCenterFromTile('some-village', undefined), true);
  });

  it('三个占地格只生成一个无内边框的三边形轮廓', () => {
    const outline = buildLandmarkTriangleOutline([
      { camX: -25.98, camY: -45 },
      { camX: -51.96, camY: 0 },
      { camX: 0, camY: 0 },
    ]);
    assert.ok(outline);
    assert.equal(outline.points.length, 3);
    assert.equal((outline.path.match(/L/g) ?? []).length, 2, '闭合路径只能包含三条边，不能沿六边形逐段拼接');
    assert.ok(outline.points[0].y < outline.points[1].y, '三角形应上窄下宽');
    assert.equal(outline.points[1].y, outline.points[2].y, '底边应保持水平');
    assert.ok(Math.abs(outline.centerX + 25.98) < 0.1, '图标中心应落在大三角水平中心');
  });
});

describe('modalLayerZ', () => {
  it('弹层容器整体高于应用导航，叠加弹窗逐层抬高', () => {
    assert.equal(modalLayerZ(0), 'calc(var(--z-scrim) + 0)');
    assert.equal(modalLayerZ(1), 'calc(var(--z-scrim) + 20)');
    assert.equal(modalLayerZ(-1), 'calc(var(--z-scrim) + 0)');
  });
});

describe('地图定位', () => {
  it('选择己方村庄只写地图定位与选中态，不会隐式切换当前村', () => {
    const calls: string[] = [];
    let target: any = null;
    inspectOwnedVillage(
      { id: 'v-branch', name: '许昌', q: 8, r: -3 },
      (center) => { calls.push(`center:${center.q},${center.r}`); },
      (next) => { calls.push('selected'); target = next; },
    );
    assert.deepEqual(calls, ['center:8,-3', 'selected']);
    assert.deepEqual(target, { refId: 'v-branch', kind: 'own_village', q: 8, r: -3, name: '许昌', icon: 'map_player_village_lv1' });
  });

  it('只有目标卡明确确认后才请求切村；当前村不会重复请求', async () => {
    const switched: string[] = [];
    const switcher = async (id: string) => { switched.push(id); return { ok: true }; };
    assert.deepEqual(await confirmOwnedVillage('v-branch', 'v-capital', switcher), { ok: true });
    assert.deepEqual(switched, ['v-branch']);
    assert.deepEqual(await confirmOwnedVillage('v-branch', 'v-branch', switcher), { ok: true });
    assert.deepEqual(switched, ['v-branch']);
  });

  it('MarchStep 同时更新己方行军和来袭预警，任务村 NPC 图标不会停在首次预警位置', () => {
    const previous = getCache();
    const warning = {
      id: 'm8-incoming', type: 'attack', battleType: 'siege', targetVillage: 'v1',
      targetVillageName: '主城', fromVillage: 'task:pve-1', fromVillageName: '天王老子村',
      from: { q: 0, r: 0 }, to: { q: 3, r: 0 }, path: [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }, { q: 3, r: 0 }],
      pos: { q: 0, r: 0 }, stepIndex: 0, perStepMs: 1000, nextStepAt: 1000, arriveAt: 4000,
    } as any;
    setCache({ moves: { movements: [], incomingWarnings: [warning] }, playerMoves: { movements: [], incomingWarnings: [warning] } });
    patchMovement({ id: warning.id, villageId: 'v1', pos: { q: 1, r: 0 }, stepIndex: 1, nextStepAt: 2000, perStepMs: 1000, status: 'marching', arriveAt: 4000 });
    for (const source of [getCache().moves, getCache().playerMoves]) {
      assert.deepEqual(source.incomingWarnings[0].pos, { q: 1, r: 0 });
      assert.equal(source.incomingWarnings[0].stepIndex, 1);
    }
    setCache(previous);
  });

  it('掉头推送的完整快照会立即替换旧出征路径', () => {
    const previous = getCache();
    const outbound = {
      id: 'mv-turn', type: 'raid', dir: 'out', status: 'marching',
      from: { q: 0, r: 0 }, originalFrom: { q: 0, r: 0 }, to: { q: 2, r: 0 },
      path: [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }], pos: { q: 1, r: 0 }, stepIndex: 1,
      perStepMs: 1000, nextStepAt: 2000, arriveAt: 3000, troops: {}, recallable: false, stoppable: false,
    } as any;
    const returning = {
      ...outbound, type: 'return', to: { q: 0, r: 0 }, path: [{ q: 1, r: 0 }, { q: 0, r: 0 }], stepIndex: 0,
      turningPoint: { from: { q: 1, r: 0 }, to: { q: 2, r: 0 }, progress: 0.5, startedAt: 1500, durationMs: 500 },
    } as any;
    setCache({ moves: { movements: [outbound], incomingWarnings: [] }, playerMoves: { movements: [outbound], incomingWarnings: [] } });
    replaceMovementSnapshot(returning);
    assert.equal(getCache().moves.movements[0].type, 'return');
    assert.deepEqual(getCache().playerMoves.movements[0].path, returning.path);
    assert.equal(getCache().playerMoves.movements[0].turningPoint.progress, 0.5);
    setCache(previous);
  });

  it('来袭预警动画态补齐 marching，图标会在两个 step 之间插值', () => {
    const warning = normalizeIncomingWarningForRender({ id: 'm8-incoming', type: 'attack', stepIndex: 0 });
    assert.equal(warning.type, 'incoming_warning');
    assert.equal(warning.status, 'marching');
  });

  it('地图地形只消费服务端字段，旧响应降级平原且未探索不泄露', () => {
    assert.equal(terrainFromTile({ terrain: 'forest' }, 'visible'), 'forest');
    assert.equal(terrainFromTile({ terrain: 'hills' }, 'explored'), 'hills');
    assert.equal(terrainFromTile(undefined, 'visible'), 'plain');
    assert.equal(terrainFromTile({ terrain: 'water' }, 'visible'), 'plain');
    assert.equal(terrainFromTile({ terrain: 'forest' }, 'unexplored'), null);
    assert.equal(terrainDisplayName('plain'), '平原');
    assert.equal(terrainDisplayName('forest'), '森林');
    assert.equal(terrainDisplayName('hills'), '丘陵');
    assert.equal(terrainDisplayName(null), '未探索区域');
  });

  it('抵达驻扎点后保留路径数据但不再显示活动路线', () => {
    const path = [{ q: 0, r: 0 }, { q: 1, r: 0 }];
    assert.equal(shouldRenderMarchPath({ status: 'marching', path }), true);
    assert.equal(shouldRenderMarchPath({ status: 'stationed', path }), false);
    assert.equal(shouldRenderMarchPath({ status: 'paused', path }), false);
    assert.equal(shouldRenderMarchPath({ status: 'marching', path: [{ q: 0, r: 0 }] }), false);
  });

  it('探索过但暂时失去视野的地形仍显示轻雾，未探索格显示重雾', () => {
    assert.equal(shouldRenderTerrainFog('visible'), false);
    assert.equal(shouldRenderTerrainFog('explored'), true);
    assert.equal(shouldRenderTerrainFog('unexplored'), true);
  });

  it('任务营地导航只保留未清理的营地', () => {
    assert.deepEqual(pendingTaskCamps([
      { id: 'camp-cleared', q: 1, r: 2, cleared: true },
      { id: 'camp-active', q: 3, r: 4, cleared: false },
    ]), [{ id: 'camp-active', q: 3, r: 4, cleared: false }]);
    assert.deepEqual(pendingTaskCamps(undefined), []);
  });

  it('回主城优先使用 capitalVillageId 对应坐标', () => {
    const player = {
      id: 'p1', name: '领主', tribe: 't1', villageId: 'v2', capitalVillageId: 'v1', q: 8, r: 9,
      villages: [
        { id: 'v1', q: 2, r: 3, name: '主城', isCapital: true },
        { id: 'v2', q: 8, r: 9, name: '分城', isCapital: false },
      ],
    };
    assert.deepEqual(capitalCoordinate(player), { q: 2, r: 3 });
  });

  it('地图回正使用当前操作村坐标，而不是主城坐标', () => {
    const player = { id: 'p1', name: '领主', tribe: 't1', villageId: 'v2', capitalVillageId: 'v1', q: 8, r: 9, villages: [] };
    assert.deepEqual(currentVillageCoordinate(player), { q: 8, r: 9 });
  });

  it('地图当前村标签使用村名而不是玩家名', () => {
    const player = {
      id: 'p1', name: '玩家名', tribe: 't1', villageId: 'v2', q: 8, r: 9,
      villages: [{ id: 'v2', q: 8, r: 9, name: '新村名', isCapital: false }],
    };
    assert.equal(currentVillageName(player), '新村名');
  });

  it('坐标跳转只接受地图范围内的完整整数', () => {
    assert.deepEqual(parseMapCoordinate('4', '7', 10, 10), { ok: true, coordinate: { q: 4, r: 7 } });
    assert.equal(parseMapCoordinate('', '7', 10, 10).ok, false);
    assert.equal(parseMapCoordinate('1.5', '7', 10, 10).ok, false);
    assert.equal(parseMapCoordinate('10', '7', 10, 10).ok, false);
  });
});

describe('村庄切换互斥状态', () => {
  it('同一时间只允许一个切换，并能在完成后解除锁定', () => {
    endVillageSwitch();
    assert.equal(beginVillageSwitch('v2', '分城'), true);
    assert.deepEqual(villageSwitching.value, { targetVillageId: 'v2', targetVillageName: '分城' });
    assert.equal(beginVillageSwitch('v3', '另一座村'), false);
    endVillageSwitch();
    assert.equal(villageSwitching.value, null);
  });
});

// ─── escapeHtml ────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('转义 < 和 >', () => {
    assert.equal(escapeHtml('<b>hello</b>'), '&lt;b&gt;hello&lt;/b&gt;');
  });

  it('转义 &', () => {
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
  });

  it('转义双引号', () => {
    assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
  });

  it('转义单引号', () => {
    assert.equal(escapeHtml("it's"), 'it&#39;s');
  });

  it('转义 XSS 向量', () => {
    assert.equal(
      escapeHtml('<script>alert("xss")</script>'),
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('null/undefined 返回空字符串', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  it('安全字符串原样返回', () => {
    assert.equal(escapeHtml('世界之王 KOW'), '世界之王 KOW');
  });

  it('数字转成字符串后转义', () => {
    assert.equal(escapeHtml(42), '42');
  });
});

// ─── escapeAttr ────────────────────────────────────────────────

describe('escapeAttr', () => {
  it('与 escapeHtml 等价', () => {
    const samples = ['<>', '"\'', '& test', '普通文本'];
    for (const s of samples) {
      assert.equal(escapeAttr(s), escapeHtml(s), `样本：${s}`);
    }
  });
});

// ─── errText ───────────────────────────────────────────────────

describe('errText', () => {
  it('undefined → 操作失败', () => {
    assert.equal(errText(undefined), '操作失败');
  });

  it('已知错误码返回中文', () => {
    assert.equal(errText('no_such_user'), '用户不存在');
    assert.equal(errText('wrong_password'), '密码错误');
    assert.equal(errText('name_taken'), '该名字已被注册');
    assert.equal(errText('spend_failed'), '资源不足');
  });

  it('训练/动员相关错误码返回中文（不再回退到“操作失败”）', () => {
    assert.equal(errText('mobilize_cap_exceeded'), '已达本族动员上限（士兵占总人口比例超限），无法继续训练');
    assert.notEqual(errText('mobilize_cap_exceeded'), '操作失败');
  });

  it('bad_troops 前缀透传中文', () => {
    assert.equal(errText('bad_troops:cavalry'), '出征兵力不合法');
  });

  it('unknown_building 前缀返回专用文案', () => {
    assert.equal(errText('unknown_building:forge'), '未知建筑');
  });

  it('联盟战事宝物校验错误返回明确文案', () => {
    assert.equal(errText('carry_cap_exceeded'), '携带宝物超出兵力上限');
    assert.equal(errText('treasure_not_held'), '所选宝物已不在该村庄，请刷新后重试');
    assert.equal(errText('unknown_treasure:horse_rope'), '所选宝物不存在或配置已更新');
  });

  it('unknown_ 通用前缀返回"目标不存在"', () => {
    assert.equal(errText('unknown_target_xyz'), '目标不存在');
  });

  it('完全未知的错误码返回固定兜底文案（不原样回显）', () => {
    assert.equal(errText('totally_unrecognized_code_xyz_123'), '操作失败');
  });
});

// ─── errText: 协议/安全相关错误码 ──────────────────────────────────

describe('errText 协议与安全错误码', () => {
  it('protocol_error 返回中文', () => {
    assert.ok(errText('protocol_error').includes('协议'));
  });

  it('version_mismatch 返回中文', () => {
    assert.ok(errText('version_mismatch').includes('协议'));
  });

  it('bad_envelope 返回中文', () => {
    assert.ok(errText('bad_envelope').includes('格式'));
  });

  it('rate_limited 返回中文', () => {
    assert.ok(errText('rate_limited').includes('频繁'));
  });

  it('invalid_payload 返回中文', () => {
    assert.ok(errText('invalid_payload').includes('格式') || errText('invalid_payload').includes('合法'));
  });

  it('message_too_large 返回中文', () => {
    assert.ok(errText('message_too_large').includes('大') || errText('message_too_large').includes('过大'));
  });
});

// ─── isCompatibleVersion ───────────────────────────────────────────

describe('isCompatibleVersion', () => {
  it('当前 WIRE_VERSION 兼容', () => {
    assert.equal(isCompatibleVersion(WIRE_VERSION), true);
  });

  it('WIRE_MIN_VERSION 兼容', () => {
    assert.equal(isCompatibleVersion(WIRE_MIN_VERSION), true);
  });

  it('低于 MIN_VERSION 不兼容', () => {
    assert.equal(isCompatibleVersion(WIRE_MIN_VERSION - 1), false);
  });

  it('高于当前版本不兼容', () => {
    assert.equal(isCompatibleVersion(WIRE_VERSION + 1), false);
  });

  it('非数字类型不兼容', () => {
    assert.equal(isCompatibleVersion('1'), false);
    assert.equal(isCompatibleVersion(null), false);
    assert.equal(isCompatibleVersion(undefined), false);
    assert.equal(isCompatibleVersion(true), false);
    assert.equal(isCompatibleVersion({}), false);
  });

  it('Infinity 不兼容', () => {
    assert.equal(isCompatibleVersion(Infinity), false);
    assert.equal(isCompatibleVersion(-Infinity), false);
  });

  it('NaN 不兼容', () => {
    assert.equal(isCompatibleVersion(NaN), false);
  });
});

// ─── PopSnapshot v2 新字段 ─────────────────────────────────────────

/** 构建测试用完整 PopSnapshot（v3 硬上限 + 劳动→士兵转化模型字段）。 */
function makePopSnap(overrides: Partial<Parameters<typeof setPopState>[0]> = {}) {
  return {
    currentPop: 100,
    soldierPop: 40,
    totalPop: 140,
    trainingPop: 0,
    hardCap: 200,
    availableLabor: 160,
    popCeiling: 160,
    laborRatio: 0.5,
    prosperityBonus: 0.5,
    prosperityMult: 1.15,
    growthPerHour: 10,
    mobilizeCap: 0.75,
    popProsperityFullRatio: 0.7,
    popProsperityMaxBonus: 0.3,
    mainLevel: 1,
    inFamine: false,
    civilianCropPerHour: 100,
    garrisonPop: 0,
    lambdaRatio: 0.5,
    wounded: { total: 0, entries: [] },
    cropDeficitRate: 0,
    laborMults: {
      production: 1.15, build: 1.15, train: 1.15, research: 1.15,
    },
    softLimit: 160,
    lastTick: Date.now(),
    fetchedAt: Date.now(),
    ...overrides,
  };
}

describe('PopSnapshot v3 硬上限 - 新字段', () => {
  it('setPopState / getPopState 含新字段', () => {
    setPopState(makePopSnap());
    const ps = getPopState();
    assert.equal(ps?.currentPop, 100);
    assert.equal(ps?.soldierPop, 40);
    assert.equal(ps?.hardCap, 200);
    assert.equal(ps?.availableLabor, 160);
    assert.equal(ps?.laborRatio, 0.5);
    assert.equal(ps?.prosperityMult, 1.15);
    assert.equal(ps?.inFamine, false);
  });

  it('currentPop=0 能正确写入（不被 falsy 过滤）', () => {
    setPopState(makePopSnap({ currentPop: 0, hardCap: 100, growthPerHour: 0 }));
    assert.equal(getPopState()?.currentPop, 0);
    assert.equal(interpolatePop(), 0);
  });

  it('inFamine=true 能正确写入', () => {
    setPopState(makePopSnap({ inFamine: true }));
    assert.equal(getPopState()?.inFamine, true);
  });

  it('interpolatePop 在增长中线性外插，上限 popCeiling', () => {
    setPopState(makePopSnap({ currentPop: 100, popCeiling: 200, growthPerHour: 3600, fetchedAt: Date.now() - 1000 }));
    const interp = interpolatePop();
    // 经过 1 秒，growthPerHour=3600 → 约 1 人/秒，应约为 101
    assert.ok(interp >= 100 && interp <= 102, `外插值 ${interp} 超出预期范围`);
  });

  it('interpolatePop 达上限附近（currentPop >= popCeiling）时不外插', () => {
    setPopState(makePopSnap({ currentPop: 200, popCeiling: 200, growthPerHour: 10 }));
    assert.equal(interpolatePop(), 200);
  });
});

// ─── 任务营地地图标记 ──────────────────────────────────────────────

describe('任务营地地图标记', () => {
  it('完整任务快照与单独地图推送都会剔除已清理营地', () => {
    const villageId = 'task-marker-test';
    const camps = [
      { id: 'camp-live', q: 1, r: 2, cleared: false },
      { id: 'camp-cleared', q: 3, r: 4, cleared: true },
    ];

    setTaskState({ villageId, active: [{ camps }] });
    assert.deepEqual(taskMarkers.value[villageId].map((camp: any) => camp.id), ['camp-live']);

    setTaskMarkers({ villageId, camps });
    assert.deepEqual(taskMarkers.value[villageId].map((camp: any) => camp.id), ['camp-live']);
  });

  it('玩家任务快照把全局营地同步到每个村庄，并清除旧坐标标记', () => {
    setTaskMarkers({ villageId: 'task-global-capital', camps: [{ id: 'stale', q: 16, r: 40, cleared: false }] });
    setPlayerTaskState({
      global: { active: [{ camps: [{ id: 'global-camp', q: 12, r: 0, cleared: false }] }] },
      villages: [
        { villageId: 'task-global-capital', active: [] },
        { villageId: 'task-global-branch', active: [] },
      ],
    });
    assert.deepEqual(taskMarkers.value['task-global-capital'], [{ id: 'global-camp', q: 12, r: 0, cleared: false }]);
    assert.deepEqual(taskMarkers.value['task-global-branch'], [{ id: 'global-camp', q: 12, r: 0, cleared: false }]);
  });

  it('任务营地标记携带任务名称与说明，地图推送不会丢失关联信息', () => {
    const villageId = 'task-detail-test';
    setTaskState({
      villageId,
      active: [{
        code: 'm3', name: '清剿野兽', desc: '清理一处骚扰村落的营地', type: 'main', scope: 'global',
        campCleared: 0, campTotal: 1, camps: [{ id: 'detail-camp', q: 4, r: 5, cleared: false }],
      }],
    });
    assert.equal(taskMarkers.value[villageId][0].taskInfo.name, '清剿野兽');
    assert.equal(taskMarkers.value[villageId][0].taskInfo.desc, '清理一处骚扰村落的营地');
    assert.equal(findTaskCampMarker('detail-camp', 4, 5)?.taskInfo.scope, 'global');

    setTaskMarkers({ villageId, camps: [{ id: 'detail-camp', q: 4, r: 5, cleared: false }] });
    assert.equal(findTaskCampMarker('detail-camp', 4, 5)?.taskInfo.name, '清剿野兽');
  });
});

// ─── PopulationChanged 事件文案 ────────────────────────────────────

describe('notificationText - PopulationChanged v3 硬上限', () => {
  it('无 event 字段时返回 null（静默增长不扰战报）', () => {
    const result = notificationText('PopulationChanged', { currentPop: 100 });
    assert.equal(result, null);
  });

  it('consumed 事件：含消耗量与当前平民数', () => {
    const result = notificationText('PopulationChanged', { event: 'consumed', consumed: 150, currentPop: 50 });
    assert.ok(result?.includes('150'), `应含消耗量 150，实际：${result}`);
    assert.ok(result?.includes('50'), `应含当前值 50，实际：${result}`);
  });

  // 服务端饥荒减员事件名为 famine / starved（含 reduced 字段）
  it('famine/starved 事件：含减员量与当前平民数', () => {
    const result = notificationText('PopulationChanged', { event: 'starved', reduced: 25, currentPop: 325 });
    assert.ok(result?.includes('25'), `应含减员量 25，实际：${result}`);
    assert.ok(result?.includes('325'), `应含当前值 325，实际：${result}`);
  });

  it('recovery 事件：含恢复提示', () => {
    const result = notificationText('PopulationChanged', { event: 'recovery', currentPop: 325 });
    assert.ok(result != null, '恢复事件应有文案');
    assert.ok(result?.includes('恢复') || result?.includes('粮食'), `应含恢复描述，实际：${result}`);
  });

  it('recovered 事件：含医院回收提示', () => {
    const result = notificationText('PopulationChanged', { event: 'recovered', recovered: 30, permanentDead: 5, currentPop: 200 });
    assert.ok(result?.includes('30'), `应含回收数 30，实际：${result}`);
  });

  it('capChanged 事件：含硬上限', () => {
    const result = notificationText('PopulationChanged', { event: 'capChanged', hardCap: 300, currentPop: 200 });
    assert.ok(result?.includes('300'), `应含硬上限 300，实际：${result}`);
  });

  it('returned 事件：含归队提示', () => {
    const result = notificationText('PopulationChanged', { event: 'returned', returned: 50, currentPop: 150 });
    assert.ok(result != null, '返回事件应有文案');
    assert.ok(result?.includes('50') || result?.includes('150'), `应含数量，实际：${result}`);
  });
});

describe('notificationText - 建筑侦察报告', () => {
  it('城内外建筑侦察同时显示守军兵力', () => {
    const result = notificationText('ScoutReport', {
      scoutType: 'scout_buildings',
      buildings: { center: [{ kind: 'townhall', name: '城镇中心', level: 1 }], inner: [], outer: [] },
      defenderTroops: { legionnaire: 4 },
    });
    assert.ok(result?.includes('城镇中心1级'), `应含建筑快照，实际：${result}`);
    assert.ok(result?.includes('军团兵4'), `应含守军兵力，实际：${result}`);
  });

  it('反侦察报告按兵种显示冒险者战损', () => {
    const result = notificationText('ScoutReport', {
      side: 'defender', detected: true, attackerVillage: 'village-a',
      deployedTroops: { adventurer: 100 }, attackerLosses: { adventurer: 100 },
    });
    assert.match(result ?? '', /冒险者100/);
    assert.match(result ?? '', /敌方损失 冒险者100/);
  });

  it('侦察失败时进攻方收到全灭战报，防守方只看到来袭兵力与死亡数', () => {
    const attacker = notificationText('ScoutReport', {
      context: 'village_scout', side: 'attacker', outcome: 'attacker_destroyed',
      deployedTroops: { adventurer: 100 }, attackerLosses: { adventurer: 100 },
      defenderTroops: { legionnaire: 10 },
    });
    assert.match(attacker ?? '', /侦察战失败/);
    assert.match(attacker ?? '', /全灭/);
    assert.match(attacker ?? '', /阵亡 冒险者100/);
    assert.doesNotMatch(attacker ?? '', /军团兵10/);

    const defender = notificationText('ScoutReport', {
      context: 'village_scout', side: 'defender', outcome: 'attacker_destroyed',
      deployedTroops: { adventurer: 100 }, attackerLosses: { adventurer: 100 },
    });
    assert.match(defender ?? '', /侦察战报告/);
    assert.match(defender ?? '', /来袭侦察兵 冒险者100/);
    assert.match(defender ?? '', /死亡 冒险者100/);
    assert.doesNotMatch(defender ?? '', /发现敌方侦察部队/);
  });
});

describe('notificationText - 来袭预警与途中侦察', () => {
  it('实时来袭预警刷新不进入战报', () => {
    assert.equal(notificationText('IncomingWarningChanged', { visible: true }), null);
  });

  it('途中侦察完胜报告包含兵力、损失与宝物识别', () => {
    const result = notificationText('ScoutReport', {
      context: 'incoming_intercept', side: 'attacker', perfectVictory: true,
      at: { q: 3, r: 4 }, defenderTroops: { legionnaire: 12 },
      attackerLosses: {}, defenderLosses: { equlegati: 2 }, treasures: ['victory_flag'],
    });
    assert.match(result ?? '', /途中侦察完胜/);
    assert.match(result ?? '', /军团兵12/);
    assert.match(result ?? '', /敌方侦察兵损失/);
    assert.match(result ?? '', /宝物/);
  });
});

describe('notificationText - 伏击报告视角', () => {
  it('被伏击方只显示自己的兵种损失和客观胜负', () => {
    const result = notificationText('BattleEnded', {
      side: 'defender', battleLabel: '伏击', attackerWins: true,
      attackPower: 800, defensePower: 500,
      attackerLosses: { legionnaire: 10 },
      defenderLosses: { equimperatoris: 2, merc_archer: 3 },
    });
    assert.match(result ?? '', /被伏击结束（失败）/);
    assert.match(result ?? '', /我方损失：近卫骑兵2/);
    assert.match(result ?? '', /弓箭雇佣兵3/);
    assert.doesNotMatch(result ?? '', /军团兵10/);
  });
});


describe('村庄资源栏受限状态', () => {
  it('资源停产后仍显示服务端提供的当前理论产量', () => {
    const rate = resourceLedgerRate(true, 0, 137.4);
    assert.equal(rate.ratePerHour, 137.4);
    assert.equal(rate.label, '停产 · +137/时');
  });

  it('资源正常生产时继续显示净变化率', () => {
    const rate = resourceLedgerRate(false, 0.025, 137.4);
    assert.equal(rate.ratePerHour, 90);
    assert.equal(rate.label, '+90/时');
  });

  it('资源悬浮明细显示基础产值、来源加成和剩余时间', () => {
    const text = breakdownTooltip('木材', [
      { kind: 'base', source: 'building:woodcutter:a', label: '资源田基础产值 · 伐木场 Lv2', ratePerHour: 100 },
      { kind: 'modifier', source: 'tech:forestry', label: '科技：林业', ratePerHour: 20, percent: 20 },
      { kind: 'timed', source: 'task:m1', label: '任务：临时鼓舞', ratePerHour: 10, percent: 10, expiresAt: Date.now() + 60_000 },
    ], 130, 130);
    assert.match(text, /资源田基础产值/);
    assert.match(text, /科技：林业：\+20\.0\/时（\+20\.0%） · 永久/);
    assert.match(text, /任务：临时鼓舞：\+10\.0\/时（\+10\.0%） · 剩余/);
    assert.match(text, /理论总产出：\+130\.0\/时/);
  });

  it('人口达到上限后显示潜在增长率而不是零', () => {
    const state = {
      hardCap: 300, inFamine: false, overflowRatio: 0, soldierPop: 80, trainingPop: 0,
      growthPerHour: 0, potentialGrowthPerHour: 12, cropDeficitRate: 0,
    };
    const growth = populationLedgerGrowth(state, 300);
    assert.equal(growth.atCap, true);
    assert.equal(growth.growthPerHour, 12);
    assert.equal(growth.label, '已满 · +12/时');
  });

  it('人口悬浮说明同时显示劳动人口和军队人口', () => {
    const state = {
      hardCap: 300, inFamine: false, overflowRatio: 0, soldierPop: 80, trainingPop: 10,
      growthPerHour: 4, potentialGrowthPerHour: 4, cropDeficitRate: 0,
    };
    const text = populationTooltip(state, 210, 120, 4);
    assert.match(text, /劳动人口 120/);
    assert.match(text, /军队人口 80/);
    assert.match(text, /训练中 10/);
  });

  it('人口悬浮说明同时显示人口增长和金币税收来源', () => {
    const text = populationTooltip({
      hardCap: 300, inFamine: false, overflowRatio: 0, soldierPop: 80, trainingPop: 0,
      growthPerHour: 6, potentialGrowthPerHour: 6, cropDeficitRate: 0,
    }, 210, 120, 6, [
      { source: 'main', label: '主基地基础人口增长（Lv2）', ratePerHour: 5 },
      { source: 'technology', label: '科技：人口法典', ratePerHour: 1, percent: 20 },
    ], [
      { source: 'gold_tax', label: '劳动人口基础税收', ratePerHour: 60 },
      { source: 'treasure', label: '宝物：金袋', ratePerHour: 12, percent: 20 },
    ]);
    assert.match(text, /主基地基础人口增长/);
    assert.match(text, /科技：人口法典/);
    assert.match(text, /劳动人口基础税收/);
    assert.match(text, /宝物：金袋/);
  });

  it('仓储溢出时说明人口增长扣减比例', () => {
    const text = populationTooltip({
      hardCap: 300, inFamine: false, overflowRatio: 0.35, soldierPop: 80, trainingPop: 0,
      growthPerHour: 4, potentialGrowthPerHour: 4, cropDeficitRate: 0,
    }, 200, 120, 4);
    assert.match(text, /告警：仓储溢出使人口增长降低 35%/);
  });

  it('饥荒时说明人口正在减少', () => {
    const text = populationTooltip({
      hardCap: 300, inFamine: true, overflowRatio: 0, soldierPop: 80, trainingPop: 0,
      growthPerHour: 0, potentialGrowthPerHour: 4, cropDeficitRate: 3,
    }, 200, 120, -3);
    assert.match(text, /告警：饥荒中，人口正在减少/);
  });
});

// ─── notificationKind：战报语义分类 ────────────────────────────────

describe('notificationKind', () => {
  it('only admits battle settlements and scout intel to reports', () => {
    assert.equal(isReportEvent('BattleEnded'), true);
    assert.equal(isReportEvent('ScoutReport'), true);
    assert.equal(isReportEvent('BuildingUpgraded'), false);
    assert.equal(isReportEvent('TroopTrained'), false);
  });

  it('建造类事件归 build', () => {
    assert.equal(notificationKind('BuildingBuilt'), 'build');
    assert.equal(notificationKind('BuildingUpgraded'), 'build');
    assert.equal(notificationKind('BuildingDemolished'), 'build');
  });

  it('训练归 train', () => {
    assert.equal(notificationKind('TroopTrained'), 'train');
  });

  it('战斗与遭遇战归 battle', () => {
    assert.equal(notificationKind('BattleStarted'), 'battle');
    assert.equal(notificationKind('BattleEnded'), 'battle');
    assert.equal(notificationKind('MarchIntercepted'), 'battle');
  });

  it('行军与拓荒归 march', () => {
    assert.equal(notificationKind('MarchSent'), 'march');
    assert.equal(notificationKind('MarchReturned'), 'march');
    assert.equal(notificationKind('VillageFounded'), 'march');
  });

  it('来袭与粮荒归 alarm（需要最高优先级提示）', () => {
    assert.equal(notificationKind('IncomingAttack'), 'alarm');
    assert.equal(notificationKind('CropDeficit'), 'alarm');
  });

  it('全部 Treasure* 事件归 treasure', () => {
    assert.equal(notificationKind('TreasureDropped'), 'treasure');
    assert.equal(notificationKind('TreasurePendingDropped'), 'treasure');
    assert.equal(notificationKind('TreasureCarriedArrived'), 'treasure');
  });

  it('人口变化默认归 pop，但饥荒减员升级为 alarm', () => {
    assert.equal(notificationKind('PopulationChanged', { event: 'capChanged' }), 'pop');
    assert.equal(notificationKind('PopulationChanged', { event: 'starved' }), 'alarm');
    assert.equal(notificationKind('PopulationChanged', { event: 'famine' }), 'alarm');
  });

  it('未知事件归 info（不抛错）', () => {
    assert.equal(notificationKind('SomethingBrandNew'), 'info');
  });
});

describe('玩家村庄地图外观', () => {
  it('中立、盟军、敌对玩家村庄使用不同描边，己方颜色不受外交值干扰', () => {
    assert.equal(mapEntityRingKind('village', false, 'neutral'), 'neutral');
    assert.equal(mapEntityRingKind('village', false, 'allied'), 'allied');
    assert.equal(mapEntityRingKind('village', false, 'hostile'), 'hostile');
    assert.equal(mapEntityRingKind('own_village', true, 'hostile'), 'self');
    assert.equal(mapEntityRingKind('own_village', false, 'hostile'), 'own');
    assert.equal(normalizeMapVillageRelation('unexpected'), 'neutral');
  });

  it('普通 PvE 不常驻红框，红色外军标记只保留给在途进攻/掠夺', () => {
    assert.equal(mapEntityRingKind('pve', false), '');
    assert.equal(foreignArmyMarkerTone('attack', 'marching'), 'threat');
    assert.equal(foreignArmyMarkerTone('raid', 'paused'), 'threat');
    assert.equal(foreignArmyMarkerTone('return', 'marching'), 'neutral');
    assert.equal(foreignArmyMarkerTone('garrison', 'stationed'), 'neutral');
    assert.equal(foreignArmyMarkerTone('attack', 'stationed'), 'neutral');
  });

  it('四级玩家村庄图标与其他正式美术统一读取 WebP', () => {
    for (let level = 1; level <= 4; level++) {
      assert.equal(artPath(`map_player_village_lv${level}`), `/art/map_player_village_lv${level}.webp`);
    }
    assert.equal(artPath('bld_main'), '/art/bld_main.webp');
  });
});

describe('战报时间线排序', () => {
  it('历史战报按服务端事件时间降序，而不是按接口返回顺序', () => {
    seedReports([
      { text: '旧', kind: 'battle', ts: 100 },
      { text: '新', kind: 'battle', ts: 300 },
      { text: '中', kind: 'battle', ts: 200 },
    ]);
    assert.deepEqual(getReports().map((report) => report.ts), [300, 200, 100]);
    seedReports([]);
  });

  it('实时战报即使乱序到达也按事件时间插入正确位置', () => {
    seedReports([]);
    addReport('新', 'battle', 300);
    addReport('旧', 'battle', 100);
    addReport('中', 'battle', 200);
    assert.deepEqual(getReports().map((report) => report.ts), [300, 200, 100]);
    seedReports([]);
  });
});

// ─── 时长 / 剩余时间格式化 ─────────────────────────────────────────
//
// 回归测试：这里曾经只有一个收「目标时刻」的 secStr，调用方（消耗预览的耗时芯片、
// 建造进度条）普遍误传**时长**，导致 ms - Date.now() 变成大负数被夹到 0，
// 界面上所有耗时一律显示「0秒」。fmtDur 收时长、secLeft 收时刻，二者不可混用。

describe('fmtDur（收时长）', () => {
  it('不足一分钟只给秒', () => {
    assert.equal(fmtDur(0), '0秒');
    assert.equal(fmtDur(1_000), '1秒');
    assert.equal(fmtDur(59_000), '59秒');
  });

  it('超过一分钟给分+秒', () => {
    assert.equal(fmtDur(60_000), '1分0秒');
    assert.equal(fmtDur(95_000), '1分35秒');
  });

  it('超过一小时给时+分', () => {
    assert.equal(fmtDur(3_600_000), '1时0分');
    assert.equal(fmtDur(3_600_000 + 25 * 60_000), '1时25分');
  });

  it('负时长夹到 0（已完成的任务不显示负数）', () => {
    assert.equal(fmtDur(-5_000), '0秒');
  });

  it('传入时长不会被当成时刻而塌成 0（这就是那个 bug）', () => {
    assert.notEqual(fmtDur(120_000), '0秒');
    assert.equal(fmtDur(120_000), '2分0秒');
  });
});

describe('secLeft（收目标时刻）', () => {
  it('未来时刻算出正的剩余时长', () => {
    assert.equal(secLeft(Date.now() + 30_000), '30秒');
  });

  it('已过去的时刻返回 0秒', () => {
    assert.equal(secLeft(Date.now() - 10_000), '0秒');
  });
});

describe('任务页菜单折叠偏好', () => {
  it('按玩家保存并恢复一级/二级/三级菜单状态，非法值不污染状态', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
    };
    const state = { global: false, 'global.daily': false, 'task:d1': true };
    writeTaskMenuOpenState('player-1', state, storage);
    assert.deepEqual(readTaskMenuOpenState('player-1', storage), state);
    assert.deepEqual(readTaskMenuOpenState('player-2', storage), {});
    data.set(taskMenuStorageKey('player-1'), JSON.stringify({ global: 'yes', village: true, nested: 1 }));
    assert.deepEqual(readTaskMenuOpenState('player-1', storage), { village: true });
  });
});

describe('王国工作区折叠偏好', () => {
  it('切换一个工作区时保留另一个工作区的展开状态', () => {
    const developmentOpen = toggleVillageWorkbench({ developmentOpen: false, militaryOpen: true }, 'developmentOpen');
    assert.deepEqual(developmentOpen, { developmentOpen: true, militaryOpen: true });
    const militaryClosed = toggleVillageWorkbench(developmentOpen, 'militaryOpen');
    assert.deepEqual(militaryClosed, { developmentOpen: true, militaryOpen: false });
  });

  it('用四态纯函数决定工作区布局，单开时可让页面使用全宽', () => {
    assert.equal(villageWorkbenchLayoutClass({ developmentOpen: false, militaryOpen: false }), 'empire-workspace-grid--both-closed');
    assert.equal(villageWorkbenchLayoutClass({ developmentOpen: true, militaryOpen: false }), 'empire-workspace-grid--development-open');
    assert.equal(villageWorkbenchLayoutClass({ developmentOpen: false, militaryOpen: true }), 'empire-workspace-grid--military-open');
    assert.equal(villageWorkbenchLayoutClass({ developmentOpen: true, militaryOpen: true }), 'empire-workspace-grid--both-open');
  });

  it('初次读取默认收起，按玩家与村庄隔离保存', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
    };
    assert.deepEqual(readVillageWorkbenchPreferences('p1', 'v1', storage), { developmentOpen: false, militaryOpen: false });
    writeVillageWorkbenchPreferences('p1', 'v1', { developmentOpen: true, militaryOpen: false }, storage);
    assert.equal(villageWorkbenchStorageKey('p1', 'v1'), 'kow.village-workbench.p1.v1');
    assert.deepEqual(readVillageWorkbenchPreferences('p1', 'v1', storage), { developmentOpen: true, militaryOpen: false });
    assert.deepEqual(readVillageWorkbenchPreferences('p1', 'v2', storage), { developmentOpen: false, militaryOpen: false });
    assert.deepEqual(readVillageWorkbenchPreferences('p2', 'v1', storage), { developmentOpen: false, militaryOpen: false });
  });

  it('坏数据、字段缺失与存储异常都退化为安全默认值', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
    };
    data.set(villageWorkbenchStorageKey('p1', 'v1'), '{坏 JSON');
    assert.deepEqual(readVillageWorkbenchPreferences('p1', 'v1', storage), { developmentOpen: false, militaryOpen: false });
    data.set(villageWorkbenchStorageKey('p1', 'v1'), JSON.stringify({ developmentOpen: true, militaryOpen: 'yes' }));
    assert.deepEqual(readVillageWorkbenchPreferences('p1', 'v1', storage), { developmentOpen: true, militaryOpen: false });
    const brokenStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    assert.deepEqual(readVillageWorkbenchPreferences('p1', 'v1', brokenStorage), { developmentOpen: false, militaryOpen: false });
    assert.doesNotThrow(() => writeVillageWorkbenchPreferences('p1', 'v1', { developmentOpen: true, militaryOpen: true }, brokenStorage));
  });
});
