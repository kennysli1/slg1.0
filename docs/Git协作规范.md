---
class: reference
status: active
updated: 2026-08-15
owner: ops
summary: 双人和多 AI 开发的分支、worktree、提交、同步、PR 与恢复流程
---

# Git 协作规范

> 本文是本项目 Git **操作流程的唯一事实源**。规则依据见
> [`00_变更契约.md`](./00_变更契约.md)；本文只解释如何安全执行，不另立规则。
> 人和任何 AI 修改项目时都必须遵守。

## 一、四个不变量

1. **开发必须在非 main 分支**：开发者可长期复用自己的开发分支；每项需求开工前必须合入最新 `origin/main`。
2. **一个写入者 = 一个独立工作目录**：不同人、AI 或并行任务使用不同 clone/worktree。
3. **`main` 只通过 PR 改变并默认自动交付**：禁止在 `main` 提交、直接 push、force push；用户要求修改项目即授权 AI 在条件满足后 squash merge。
4. **生产只来自 `origin/main`**：功能分支已部署不代表已合入；正式部署必须在 PR 合并后执行。

必须区分三个完成状态：

| 状态 | 判断依据 |
|---|---|
| 功能分支已同步 main | 功能分支执行过 `git merge origin/main` |
| 功能已合入 main | GitHub PR 显示 `Merged`，且提交包含在 `origin/main` |
| 功能已部署 | `npm run deploy:prod` 成功，公网 `/version` 对应目标 `origin/main` SHA |

任何 AI 不得用“已经 merge”笼统代替以上三个状态。

## 二、最小心智模型

- **工作目录**：磁盘上当前文件；不同分支不会隔离同一目录里的未提交修改。
- **暂存区**：下一次 commit 准备包含的文件。
- **commit**：不可变代码快照。
- **branch**：指向 commit 的可移动名称。
- **HEAD**：当前检出的分支或 commit，不等于“最新 main”。
- **`origin/main`**：最近一次 fetch 得到的远程 main 位置；判断前先 fetch。
- **pull**：fetch 后再整合，行为依赖当前分支；本规范优先使用显式 fetch + merge。

Git 通常会拒绝非快进 push，不会自动覆盖远程提交；真正的覆盖风险主要来自共享工作目录、错误解决冲突、force push、reset/clean，以及把未合入 main 的分支直接部署。

## 三、首次配置

每台开发机器首次 clone 后执行：

```bash
npm install
git remote get-url origin
gh auth status
gh repo view kennysli1/slg1.0 --json nameWithOwner
gh api repos/kennysli1/slg1.0 --jq '{full_name,permissions}'
git config user.name "你的 GitHub 姓名"
git config user.email "你的 GitHub 邮箱"
git config --get core.hooksPath
git config --get pull.ff
git config --get fetch.prune
git config --get rerere.enabled
```

每个新建 worktree 都需要独立安装依赖；进入该目录后执行 `npm run worktree:prepare`。`node_modules/` 已被 Git 忽略，禁止用跨 worktree 软链接替代安装，以免 ESM 解析或提交快照检查出现假失败。

预期配置：钩子目录为 `.githooks`、`pull.ff=only`、`fetch.prune=true`、`rerere.enabled=true`。缺失时执行：

```bash
npm run hooks:install
```

不得共用 Git 身份；不得使用 `.local` 或 `localhost.localdomain` 邮箱。规范仓库标识是 `kennysli1/slg1.0`；`origin` 必须指向它，API 返回的 `permissions.push` 必须为 `true`。`gh` 缺失、未登录、仓库或权限不符时停止并报告。

## 四、隔离工作目录

两人在不同电脑各自 clone，天然隔离。若同一电脑运行多个 AI，必须让每个并行写入者使用独立 worktree 和独立分支。先确认没有陌生修改：

```bash
git status --short --branch
git fetch --prune origin
git worktree list
```

长期开发分支首次创建时，可以同时建立固定工作目录：

```bash
git worktree add ../slg1.0-姓名 -b dev/姓名 origin/main
git -C ../slg1.0-姓名 push -u origin dev/姓名
```

以后让该开发者或 AI 固定使用这个目录和分支。一个分支不能同时被两个 worktree 检出；一个 worktree 同一时刻只允许一个写代码的 AI。临时并行任务仍须另建分支和 worktree，结束后可保留或按明确指令清理。

长期 worktree 在 PR 合并后**不删除**。只有明确废弃且工作区干净、全部提交已推送并合入 main 时，才在其他 worktree 中按准确路径移除：

```bash
git worktree remove ../slg1.0-姓名
git worktree prune
```

不得用 `--force` 绕过 worktree 检查；删除分支属于独立操作，不是合并后的默认收尾。

## 五、标准开发流程

### 1. 开工检查

每个修改任务开始时必须执行：

```bash
git status --short --branch
git branch --show-current
git rev-parse --show-toplevel
git rev-parse --short HEAD
git branch -vv
git fetch --prune origin
git status --short --branch
git branch -vv
```

满足以下条件才能继续：

- 当前目录是分配给该写入者的 clone/worktree；
- 工作区干净，或现有改动经确认属于当前任务；
- 当前分支不是 `main`/`master`；
- 分支名能识别负责人，且没有被其他人或 AI 同时写入；
- AI 已说明准备修改的文件范围。

看到不认识的修改必须停止并报告，不得擅自 stash、提交、恢复或删除。

### 2. 首次创建或继续长期开发分支

已有本地开发分支时，每项需求开始前执行：

```bash
git status --porcelain
git fetch --prune origin
git switch dev/姓名
git merge origin/main
git push -u origin HEAD
```

第一条命令有输出时不得切分支，先确认改动归属。如果本地没有、远程已有个人分支：

```bash
git switch --track origin/dev/姓名
```

本地和远程都没有时只需首次创建：

```bash
git switch -c dev/姓名 origin/main
git push -u origin HEAD
```

分支名建议使用 `dev/<owner>`；临时分支可用 `<type>/<owner>-<description>`。`/` 只作路径分隔，每个路径段只用小写 ASCII 字母、数字和连字符。长期分支允许跨需求复用，但每次开始前都必须工作区干净、fetch 并 merge 最新 `origin/main`。

### 3. 修改与提交

写代码阶段默认串行；两项任务会修改同一 owner 模块、协议、索引或 CHANGELOG 时，先约定文件所有权或改为串行。

提交前：

```bash
git status --short
git diff
git add <明确列出的候选文件>
git diff --cached --check
git diff --cached
git status --short
```

确认暂存快照完整，并按变更契约更新索引、CHANGELOG 和版本号。不得顺手提交其他人或其他任务的文件。

正常提交，让钩子执行验证：

```bash
git commit -m "<type>(<scope>): <中文主题>"
git push -u origin HEAD
```

提交钩子先做作者/工作区快检，再校验提交信息，最后才跑完整构建、测试和生产冒烟；因此应始终使用格式正确的说明，避免无效说明触发昂贵验证。

提交信息示例：

```text
feat(task): 增加任务奖励领取弹窗
fix(ops): 修正生产版本切换流程
docs(git): 完善双人协作规范
```

禁止使用 `--no-verify`。commit 是本地快照，push 到功能分支才有远程副本，两者都不代表进入 main。

### 4. 同步最新 main

准备 PR 或 GitHub 提示分支落后时，在功能分支执行：

```bash
git status --porcelain
git fetch --prune origin
git branch --show-current
git merge origin/main
```

第一条命令有输出时先处理当前改动；第三条必须显示本人的非 main 开发分支，若为空或是 `main`/`master` 则停止。合并成功后运行相应测试，再 push：

```bash
npm run verify:quick
git push
```

本项目默认使用 merge 同步功能分支，避免新手 rebase 后误用 force push。只有分支唯一负责人明确理解历史重写时，才能另行决定 rebase，并且绝不对 `main` 或多人共用分支 rebase/force push。

### 5. 创建 PR、等待检查并自动合并

当前 GitHub 规则要求 PR 和 `verify`，但强制批准人数为 `0`，不需要另一人审批。创建 PR：

```bash
git push -u origin HEAD
gh pr create --base main --fill
gh pr view --web
```

等待检查：

```bash
gh pr checks --watch
```

检查失败时用 `gh pr checks` 取得失败项并修复；长时间没有结果可以中断等待，但不得把等待中当作通过。**用户要求 AI 修改本项目，即同时授权标准交付链路：commit → push 功能分支 → 创建 PR → 等待 checks → 条件满足后 squash merge；AI 不得在 checks 已通过且可合并时无故停在 Open PR。** 只有用户明确要求“只审查”“暂不提交”“暂不推送”“暂不合并”或“创建 Draft PR”时，才在对应阶段停止。

合并前机器核验（把占位符替换为确切值）：

```bash
git fetch --prune origin
gh pr view <PR编号> --json number,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
git rev-parse origin/<功能分支>
git rev-list --left-right --count origin/main...origin/<功能分支>
```

要求 PR 为 Open 且非 Draft、base=`main`、head 名与 SHA 匹配远程功能分支、领先/落后输出的第一个数为 `0`、checks 全部成功且 `mergeable` 不为冲突。普通 `gh pr view` 不能完整证明讨论已解决，必须在 PR 页面确认；无法查看时不得猜测，GitHub 保护规则也会拒绝违规合并。全部满足后，AI 应直接使用 squash，不再等待重复批准：

```bash
gh pr merge --squash
```

仓库设置 `delete_branch_on_merge` 必须保持 `false`；若发现为 `true`，停止合并并报告，避免长期分支被 GitHub 自动删除。

若仓库规则改变，以 GitHub 实际保护规则为准，但不得自行降低保护或绕过检查。AI 必须报告 PR 链接、检查结果和最终合并状态；PR 仅创建或获得批准都不等于已合并。

### 6. 合并后的收尾

长期开发分支和 worktree 默认保留。由于 squash 会在 main 上生成新 commit，PR 合并后必须把这个 commit 合回开发分支，建立新的共同祖先：

```bash
git fetch --prune origin
git switch dev/姓名
git merge origin/main
git push
git diff --stat origin/main...HEAD
```

最后一条在尚未开始下一项需求时应无输出；若仍有差异，说明分支存在未合入或意外改动，必须先查明。此同步步骤保证下一次从同一分支创建 PR 时不会重复带出已经 squash 的旧改动。不得因为 PR 已合并就自动删除本地/远程分支或 worktree。

### 7. 部署

只有用户明确要求上线，并且 PR 已合入远程 main 时才执行：

```bash
git fetch --prune origin
npm run deploy:prod
```

部署脚本只发布 `origin/main`。禁止直接部署功能分支，也禁止用“功能分支线上可见”代替 PR。

## 六、冲突处理

`git merge origin/main` 出现冲突时：

```bash
git status
git diff --cc
```

逐个文件理解三个版本：当前功能分支、`origin/main`、双方共同基点。解决原则：

1. 先说明双方意图，再编辑最终结果；
2. 不得对全部文件批量选择 ours/theirs；
3. 删除冲突标记 `<<<<<<<`、`=======`、`>>>>>>>`；
4. 同时保留双方必要逻辑，并检查接口、类型、文档索引和 CHANGELOG；
5. 对二进制、配置表、协议和存档冲突必须由负责人明确裁决；
6. 解决后执行 `git add <文件>`，再确认 `git diff --cached` 和测试。

完成：

```bash
git add <已解决文件>
git status
npm run verify:quick
git commit
git push
```

无法确定正确结果时，保持冲突并报告；如果合并前工作区干净，可用 `git merge --abort` 回到合并前。不得为了“让 Git 变绿”而丢弃任一方代码。

Git 只能发现文本冲突，无法发现双方修改不同文件却破坏同一行为的逻辑冲突，因此 PR 前仍需测试和差异检查。

## 七、HEAD 与分支诊断

AI 声称“HEAD 不对”“被覆盖”“已合并”之前，必须提供以下证据：

```bash
git fetch --prune origin
git status --short --branch
git branch --show-current
git rev-parse --short HEAD
git rev-parse --short origin/main
git branch -vv
git log --graph --decorate --oneline --all -20
git rev-list --left-right --count origin/main...HEAD
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

判断当前提交是否已经被 main 包含：

```bash
git merge-base --is-ancestor HEAD origin/main \
  && echo "HEAD 已被 origin/main 包含" \
  || echo "HEAD 尚未被 origin/main 包含"
```

注意：squash merge 会生成新 commit，原功能 commit 不一定成为 main 的祖先；此时应同时检查 GitHub PR 的 `Merged` 状态和实际差异，不能只靠 commit 祖先关系。

`git branch --show-current` 没有输出表示 detached HEAD。此时不得继续普通开发或直接提交；先保留现场并报告，必要时在当前提交创建恢复分支：

```bash
git switch -c recovery/姓名-日期-说明
```

## 八、常见错误

| 错误/现象 | 原因 | 正确处理 |
|---|---|---|
| `couldn't find remote ref master` | 远程主分支叫 `main` | `git fetch origin`，使用 `origin/main` |
| `non-fast-forward` | 远程分支有本地没有的提交 | fetch 后检查差异；功能分支按约定 merge，禁止 force |
| `protected branch` / `GH006` | 尝试直接修改 main | push 功能分支，创建 PR |
| PR 仍要求处理 | 检查失败、分支落后、冲突或讨论未解决 | 查看 `gh pr checks` 和 PR 页面，修复后再合并 |
| `already checked out at ...` | 同一分支已被其他 worktree 使用 | 使用对应固定目录；并行写入则另建临时分支/worktree |
| `local changes would be overwritten` | 切换会覆盖未提交文件 | 停止，确认改动归属；不得自动 stash/reset |
| PR 已合并但 HEAD 不同 | squash 生成了新的 main commit | 按第 6 步把 `origin/main` 合回长期分支 |
| merge 成功但功能消失 | 冲突解决错误或存在逻辑冲突 | 检查 merge commit 差异、测试和 PR；不要批量 ours/theirs |

## 九、默认禁止的操作

未经用户明确授权并确认准确目标，AI 不得执行：

```text
git reset --hard
git clean -fd
git checkout -- .
git restore .
git stash / git stash pop
git push --force / --force-with-lease
git branch -D
git commit --no-verify
git push --no-verify
```

也不得删除陌生分支/worktree、提交陌生修改、改变 GitHub 保护规则、在生产服务器操作源码，或用未解析的变量和通配符执行清理命令。

## 十、AI 开工与交付报告

AI 开工时必须报告：

```text
工作目录：<绝对路径>
当前分支：<branch>
HEAD：<short SHA>
上游：<upstream>
工作区：clean / 已确认的文件列表
本次文件范围：<计划修改的文件或模块>
与 origin/main：领先 N、落后 M
```

AI 交付时必须报告：

```text
功能分支与 HEAD：<branch> @ <short SHA>
实际修改：<文件与目的>
验证：<命令与结果>
远程备份：已 push / 未 push
PR：<URL、checks、Open/Merged>
main：已合入 / 尚未合入
部署：未执行 / origin/main @ <SHA> 已部署
遗留：<冲突、未提交文件或后续动作>
```

没有证据时必须说“尚未确认”，不得猜测。任何异常先保留现场、执行只读诊断并报告；不得用破坏性命令把状态“清干净”。
