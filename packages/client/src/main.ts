import './style.css';
import { bootstrap } from './app/bootstrap.js';

/**
 * 文字版 Travian 前端（多人版）入口。
 * 职责仅"启动" —— 实际编排在 app/bootstrap.ts，页面在 features/*，
 * 共享原子在 shared/*，配置缓存在 app/config.ts（消费服务端 GetGameConfig）。
 */
bootstrap();
