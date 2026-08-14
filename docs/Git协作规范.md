---
class: reference
status: active
updated: 2026-08-14
owner: ops
summary: 双人和多 AI 开发的分支、worktree、提交、同步、PR 与恢复流程
---

# Git 协作规范

> 本文是本项目 Git **操作流程的唯一事实源**。规则依据见
> [`00_变更契约.md`](./00_变更契约.md)；本文只解释如何安全执行，不另立规则。
> 人和任何 AI 修改项目时都必须遵守。

## 一、四个不变量

1. **一个需求 = 一个功能分支**：每次从最新 `origin/main` 新建；已合并分支不得承接新需求。
2. **一个写入者 = 一个独立工作目录**：不同人、AI 或并行任务使用不同 clone/worktree。
3. **`main` 只通过 PR 改变**：禁止在 `main` 提交、直接 push、force push；功能分支同步 main 不等于合入 main。
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

预期配置：钩子目录为 `.githooks`、`pull.ff=only`、`fetch.prune=true`、`rerere.enabled=true`。缺失时执行：

```bash
npm run hooks:install
```

不得共用 Git 身份；不得使用 `.local` 或 `localhost.localdomain` 邮箱。规范仓库标识是 `kennysli1/slg1.0`；`origin` 必须指向它，API 返回的 `permissions.push` 必须为 `true`。`gh` 缺失、未登录、仓库或权限不符时停止并报告。

## 四、隔离工作目录

两人在不同电脑各自 clone，天然隔离。若同一电脑运行多个 AI/任务，必须使用 worktree。先在主工作目录确认没有陌生修改：

```bash
git status --short --branch
git fetch --prune origin
git worktree list
```

为新任务创建独立目录和分支：

```bash
git worktree add ../slg1.0-任务名 \
  -b feat/姓名-任务名 origin/main
```

让对应 AI 的工作目录固定为新目录。一个分支不能同时被两个 worktree 检出；一个 worktree 同一时刻只允许一个写代码的 AI。

任务合并后，在其他 worktree 中执行：

```bash
git worktree remove ../slg1.0-任务名
git worktree prune
```

移除前必须确认工作区干净、提交已推送且 PR 已合并；分支按第五节第 6 步核验并删除。不得用 `--force` 绕过 worktree 检查。

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

- 当前目录是分配给本任务的 clone/worktree；
- 工作区干净，或现有改动经确认属于当前任务；
- 当前分支不是 `main`/`master`；
- 分支名能识别负责人和需求；
- AI 已说明准备修改的文件范围。

看到不认识的修改必须停止并报告，不得擅自 stash、提交、恢复或删除。

### 2. 创建新任务分支

普通独立 clone/工作目录使用：

```bash
git status --porcelain
git fetch --prune origin
git switch main
git pull --ff-only origin main
git switch -c feat/姓名-任务名
```

第一条命令有输出时不得切分支，先确认改动归属。分支格式为 `<type>/<owner>-<description>`，`type` 使用 `feat`、`fix`、`docs`、`refactor`、`test`、`chore` 等；名称只用小写 ASCII 字母、数字和连字符，并且已完成的分支名不得复用。

使用 worktree 时，直接按第四节从 `origin/main` 创建，不需要在任务目录切换 main。

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

第一条命令有输出时先处理当前改动；第三条必须显示本任务功能分支，若为空或是 `main`/`master` 则停止。合并成功后运行相应测试，再 push：

```bash
npm run verify:quick
git push
```

本项目默认使用 merge 同步功能分支，避免新手 rebase 后误用 force push。只有分支唯一负责人明确理解历史重写时，才能另行决定 rebase，并且绝不对 `main` 或多人共用分支 rebase/force push。

### 5. 创建 PR 并自助合并

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

检查失败时用 `gh pr checks` 取得失败项并修复；长时间没有结果可以中断等待，但不得把等待中当作通过。只有用户明确要求交付/合入 main，或已批准的任务流程明确包含合并时，AI 才能执行外部合并。

合并前机器核验（把占位符替换为确切值）：

```bash
git fetch --prune origin
gh pr view <PR编号> --json number,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
git rev-parse origin/<功能分支>
git rev-list --left-right --count origin/main...origin/<功能分支>
```

要求 PR 为 Open 且非 Draft、base=`main`、head 名与 SHA 匹配远程功能分支、领先/落后输出的第一个数为 `0`、checks 全部成功且 `mergeable` 不为冲突。普通 `gh pr view` 不能完整证明讨论已解决，必须在 PR 页面确认；无法查看时不得猜测，GitHub 保护规则也会拒绝违规合并。全部满足后使用 squash：

```bash
gh pr merge --squash --delete-branch
```

若仓库规则改变，以 GitHub 实际保护规则为准，但不得自行降低保护或绕过检查。AI 必须报告 PR 链接、检查结果和最终合并状态；PR 仅创建或获得批准都不等于已合并。

### 6. 合并后的收尾

普通工作目录：

```bash
git fetch --prune origin
git switch main
git pull --ff-only origin main
```

本仓库使用 squash merge，Git 不会把原功能 commit 视为 main 的祖先，因此 `git branch -d` 可能拒绝删除。先取得 PR 编号，并核验 PR 已合并、PR 的 `headRefOid` 与待删本地分支 HEAD 完全一致：

```bash
gh pr list --state merged --base main --head feat/姓名-任务名 --limit 2 \
  --json number,url,mergedAt,headRefOid
git rev-parse feat/姓名-任务名
```

查询结果必须恰好一条；PR 的 `headRefOid` 与本地分支 HEAD 一致、工作区干净时，允许删除这个**明确命名**的已合并本地分支。`--delete-branch` 通常已经删除远程分支，这是预期结果：

```bash
git branch -D feat/姓名-任务名
```

没有匹配的 merged PR、SHA 不一致或存在未推送提交时停止并报告。worktree 要先在其他目录完成上述 PR/SHA 核验，再按第四节移除任务目录，最后删除本地分支。

下一项需求重新从最新 `origin/main` 建分支，不得继续使用已经完成的分支。

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
| `already checked out at ...` | 同一分支已被其他 worktree 使用 | 使用对应目录，或为新任务创建新分支 |
| `local changes would be overwritten` | 切换会覆盖未提交文件 | 停止，确认改动归属；不得自动 stash/reset |
| 当前分支已合并但 HEAD 不同 | 仍停留在旧功能分支，或使用了 squash | 确认 PR 后收尾，从最新 main 新建分支 |
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
git branch -D（第五节已核验的 squash 分支收尾除外）
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
