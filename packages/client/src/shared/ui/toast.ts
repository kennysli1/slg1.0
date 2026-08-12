/**
 * Toast 入口。真正的实现（信号驱动的 Toast 渲染）在 app/store 里；
 * 这里仅做再导出，让 bootstrap / army / village 等旧的
 * `import { showToast } from '../shared/ui/toast.js'` 引用继续可用，
 * 避免重复实现导致行为分叉。
 */
export { showToast } from '../../app/store.js';
export type { ToastEntry } from '../../app/store.js';
