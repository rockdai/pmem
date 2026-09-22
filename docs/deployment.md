# 自托管部署

运行基线为 Node.js 24、pnpm 10.32.1。一个部署只有一个账号和一个活动服务进程；多台设备通过同一 Web 地址使用。不要运行多个副本、PM2 cluster 或让外部程序同时修改数据目录 / OSS 前缀。每篇笔记最多 1 MiB UTF-8 Markdown。没有数据库、搜索、索引、备份、回收站或历史版本。

## 本机启动

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
chmod 600 .env
pnpm --silent setup key
# 以下密码输入命令在 Bash 中执行，不把密码放进命令历史或参数：
read -r -s -p 'Password (12+ characters): ' pmem_password
printf '%s' "$pmem_password" | pnpm --silent setup hash-password
unset pmem_password
```

将两条命令的结果分别填入 `.env` 的 `PMEM_SESSION_KEY`、`PMEM_PASSWORD_HASH`；不要加引号，保留哈希中的 `$`。填写个人账号和准确的 `PMEM_ORIGIN`（无末尾 `/`）。`.env` 不要提交到 Git，不要复制到镜像。密码哈希或账号变更后重启，旧 Cookie 会失效；更换会话密钥也会失效，并改变浏览器草稿的部署命名空间，操作前先同步或复制草稿。

```bash
pnpm build
pnpm start
```

访问 `http://localhost:3000`。本地正文在 `.pmem/data/notes/<UUID>.md`；只有内容与 Markdown 格式，没有页面 HTML 或 JSON 外壳。`PMEM_DATA_DIR` 可指定专用目录，操作系统用户必须有创建、替换、删除及 fsync 权限。不要通过符号链接提供 notes 目录。推荐本机 SSD 文件系统，不承诺网络文件系统的原子发布语义。

开发 Web 时，另开终端运行 `pnpm dev:web`，并将 `.env` 的 `PMEM_ORIGIN` 改为 `http://localhost:5173`，服务端运行 `pnpm dev`。Vite 代理 API；性能测试必须使用正式构建。

## 容器：本地与 OSS 二选一

需要 Docker 和 Compose 2.30 或以上；`env_file: format: raw` 用于避免密码哈希的 `$` 被展开。镜像以 UID/GID 1000 的 `node` 用户运行，监听容器 3000 端口。示例仅向宿主机回环地址发布端口。

准备 `.env` 后，本地模式：

```bash
docker compose --profile local up -d --build
docker compose --profile local logs --tail 30
```

Compose 将专用 `notes` 命名卷挂在 `/data`；OSS 服务使用另一个 `state` 命名卷挂在 `/state`。不要同时启用两个 profile，不要扩容服务，也不要执行会删除数据卷的清理命令。使用宿主机 bind mount 时预先创建目录并赋予 UID 1000 读写权限。

公开访问必须配置 HTTPS 和 `PMEM_ORIGIN=https://你的域名`。例如宿主机 Caddy：

```caddyfile
notes.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Web/API 同源，不直接公开 OSS。外部 HTTP Origin 会在启动时被拒绝；本机 loopback HTTP 仅供开发。应用提供 HttpOnly、SameSite=Strict 会话 Cookie、Origin/CSRF 检查和登录限流（每个连接来源每 15 分钟 10 次）；反向代理下该额度由代理来源共享，适合单人部署。代理应允许至少 1 MiB 请求体，不缓存 `/api/`。构建产物含预压缩资源，应用按 Accept-Encoding 返回 gzip；HTML 不使用长缓存。

## OSS 初始化与权限

使用私有 Bucket，地域例如 `oss-cn-hangzhou`。Bucket 必须**从未启用版本控制**；Enabled、Suspended 或读取版本状态失败都会拒绝启动。`PMEM_OSS_PREFIX` 是独占简单前缀，例如 `pmem/`。填写 `.env` 中全部 OSS 参数。RAM 凭据只在服务端使用；不要使用主账号密钥。

将以下策略中的 `YOUR_BUCKET` 和 `pmem/` 换为实际值。应用直接请求指定前缀，不需要控制台列出所有 Bucket 的权限。HEAD 使用 `oss:GetObject`；ListObjectsV2 使用 Bucket 级 `oss:ListObjects` 加 `oss:Prefix` 条件；版本检查需要独立的 Bucket 级权限。依据：[OSS 授权操作与条件](https://www.alibabacloud.com/help/en/oss/user-guide/authorization-syntax-and-elements)、[前缀访问策略](https://www.alibabacloud.com/help/en/oss/user-guide/access-control-base-on-ram-policy)。

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["oss:GetBucketVersioning"],
      "Resource": ["acs:oss:*:*:YOUR_BUCKET"]
    },
    {
      "Effect": "Allow",
      "Action": ["oss:ListObjects"],
      "Resource": ["acs:oss:*:*:YOUR_BUCKET"],
      "Condition": {"StringLike": {"oss:Prefix": ["pmem/notes/*"]}}
    },
    {
      "Effect": "Allow",
      "Action": ["oss:GetObject", "oss:PutObject", "oss:DeleteObject"],
      "Resource": ["acs:oss:*:*:YOUR_BUCKET/pmem/notes/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["oss:GetObject", "oss:PutObject"],
      "Resource": ["acs:oss:*:*:YOUR_BUCKET/pmem/control/state-owner"]
    }
  ]
}
```

首次初始化必须使用空 notes 前缀、原状态卷以及停止的应用服务：

```bash
docker compose --profile oss build
docker compose --profile oss run --rm --no-deps pmem-oss node dist/server/cli.js init-oss
docker compose --profile oss up -d
```

直接 Node 部署则设置 `PMEM_STORAGE=oss` 和持久化 `PMEM_STATE_DIR`，先执行 `pnpm setup init-oss`，再 `pnpm start`。容器强制 `/state` 独立挂载，Linux 上拒绝 tmpfs/ramfs。状态卷只有身份和待确认操作元数据，不保存笔记正文，不构成第二份正文存储。

初始化先同步本地 `owner.json`，再以禁止覆盖方式创建 `control/state-owner`。若初始化中断，保留原卷、原配置，重新执行初始化；不会生成新身份去覆盖已有标记。标记存在但本地身份缺失或不匹配时，即使显式初始化也会拒绝。启动失败先核对 Bucket、地域、RAM 权限、版本状态、原卷挂载及文件权限，不要删除 pending 记录来“修复”。

每次修改前先同步 pending 记录，OSS SDK 修改请求不自动重试。超时不能证明写入未发生；该笔记保持暂停，后台只能读回核对。读到目标内容或删除目标已不存在才解除；读到旧内容仍暂停。浏览器显示“保存结果待确认”，草稿保留，可复制或以新 ID 另存。服务重启继续遵循原 pending 记录。

每个可见页面约每分钟 12 次当前笔记条件检查。缓存已热时通常对应 12 次 HEAD，不下载正文；首次读取、进程重启、128 项缓存淘汰或闲置 30 分钟后需要完整 GET。HEAD 和列表均有请求成本。列表每次完整列举文件元数据，只读取当前页最多 50 篇的前 8 KiB；10,000 篇约需 10 个 ListObjectsV2 页面，不宣称固定首屏延迟。

## OSS 状态卷永久丢失

首先挂回原卷；若确实无法恢复，**不能**从远端身份标记重建空卷，不能依赖“已等待足够久”判断旧写入终止，也不能直接删掉原标记重新启用原前缀。

人工恢复使用一个全新的前缀，隔离可能仍然迟到的旧请求：

1. 停止全部旧实例，撤销旧写凭据。保留原前缀及其 `control/state-owner`，不恢复应用对旧前缀的写权限。
2. 通过 OSS 控制台或官方工具，以只读身份读取原 `notes/` 的当前文件到人工工作目录。核对文件数、ID、正文和摘要。浏览器内未同步文字另行复制；服务端无法凭空恢复从未上传的草稿。
3. 创建新的空前缀（例如 `pmem-recovered-20260923/`）、新的状态卷和仅能写新前缀的新 RAM 凭据。更新配置及策略；在应用停止状态执行上述 `init-oss`，记录初始化成功。
4. 使用人工工具将已核对的 `.md` 正文上传到新前缀的 `notes/`，保持文件名；不要复制旧 `control/` 或重建旧 pending 记录。只有这一步完成后才启动新实例，登录、浏览并逐篇检查重要内容。
5. 原前缀保持隔离。如果旧请求后来改变了旧正文，人工比较后显式决定如何处理；不能自动合并或覆盖新前缀。迁移时的文件读取不是一致性快照，无法保证包含未知在途请求的最终内容。

这是故障后的人工处置说明，产品不提供自动迁移、备份、历史或强制解锁功能。没有可信的旧请求终止证明时，不重新使用旧前缀。新前缀改变浏览器部署身份，旧草稿不会自动归入新部署，因此切换前应尽量导出或复制。

## 验证命令与未覆盖环境

```bash
pnpm build
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm bench:web
pnpm bench:list
# 可选的弱网或长文压力样本；CDP 限速不包含 1% 丢包：
PMEM_BENCH_NETWORK=weak pnpm bench:web
PMEM_BENCH_CHARACTERS=20000 pnpm bench:web
PMEM_BENCH_CHARACTERS=330000 pnpm bench:web
```

真实 OSS 集成需要专门的空测试前缀和授权测试凭据；不会默认连接用户 Bucket：

```bash
PMEM_OSS_INTEGRATION=1 PMEM_OSS_TEST_PREFIX=test-unique-run-name/ pnpm test:oss
```

为该测试前缀单独授予同类权限，并额外允许删除该测试前缀的 `control/state-owner`。脚本只删除本轮创建的确切键，不递归清空前缀；初始化中断可能留下一份隔离的测试身份标记，先检查后再人工清理，不复用有未知请求的前缀。

容器本地存储冒烟：`docker build -t pmem:ci .` 后 `bash scripts/container-smoke.sh`。另需在测试 OSS 环境检查正常重启、断网写入、空卷、错卷、tmpfs、遗漏独立挂载：启动失败必须发生在任何正文修改之前。丢包、云端请求延迟、真机中文键盘、Safari/Chrome 移动版与正式 Linux 服务器的硬指标需要单独验收，实际证据见 [验证记录](validation/task-090.md)。
