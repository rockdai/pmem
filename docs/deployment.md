# 自托管部署

运行基线为 Node.js 24；源码开发另需 pnpm 10.32.1。一个部署只有一个账号和一个活动服务进程；多台设备通过同一 Web 地址使用。不要运行多个副本、PM2 cluster 或让外部程序同时修改数据目录 / OSS 前缀。每篇笔记最多 1 MiB UTF-8 Markdown。没有数据库、搜索、索引、备份、回收站或历史版本。

## npm 安装与配置

```bash
npm install -g @rockdai/pmem
mkdir -p ~/.pmem
cp "$(npm root -g)/@rockdai/pmem/pmem.example.json" ~/.pmem/pmem.json
chmod 600 ~/.pmem/pmem.json
pmem key
# 以下密码输入命令在 Bash 中执行：
read -r -s -p 'Password (12+ characters): ' pmem_password
printf '%s' "$pmem_password" | pmem hash-password
unset pmem_password
```

将两条命令的结果分别填入 `sessionKey`、`passwordHash`，并填写 `account`。配置文件使用标准 JSON，例如：

```json
{
  "account": "me",
  "passwordHash": "粘贴 pmem hash-password 的结果",
  "sessionKey": "粘贴 pmem key 的结果",
  "origin": "http://localhost:3000",
  "host": "127.0.0.1",
  "port": 3000,
  "storage": "local",
  "dataDir": "data",
  "stateDir": "state",
  "allowInsecureHttp": false
}
```

| 字段 | 默认值或要求 |
| --- | --- |
| `account` | 必填，个人登录账号 |
| `passwordHash` | 必填，使用 `pmem hash-password` 生成，密码至少 12 字符 |
| `sessionKey` | 必填，使用 `pmem key` 生成的 64 位十六进制字符串 |
| `origin` | `http://localhost:<port>`；必须与浏览器地址完全一致，不带路径及末尾 `/` |
| `host` / `port` | `127.0.0.1` / `3000`；端口为 JSON 整数 |
| `storage` | `local`，可选 `oss` |
| `dataDir` / `stateDir` | 配置文件旁的 `data` / `state`，支持绝对路径、相对路径和 `~/` |
| `allowInsecureHttp` | `false`；可信内网明文 HTTP 必须显式设为布尔值 `true` |
| `oss` | OSS 模式必填，包含 `bucket`、`accessKeyId`、`accessKeySecret`；`region` 和 `endpoint` 至少填写一个，两者都填时优先使用 `endpoint`；可选 `prefix` 指定存储前缀（默认为空） |

配置使用 JSON 文件，默认地址为 `~/.pmem/pmem.json`，`-c` 可指定其他文件。容器镜像内部的 `PMEM_CONTAINER=1` 仅用于启用持久挂载检查。未知字段、无效类型和非法值会在启动时被拒绝。配置缺失不会自动生成账号或密码。

配置文件不要提交到 Git，不要复制到镜像。手动修改配置后重启生效。密码哈希或账号变更会使旧 Cookie 失效；更换会话密钥也会失效，并改变浏览器草稿的部署命名空间，操作前先同步或复制草稿。

修改现有配置的密码可执行 `pmem passwd`，或 `pmem passwd -c /path/to/pmem.json`。在交互式终端隐藏输入两次新密码（至少 12 字符、最多 1024 UTF-8 字节），一致后自动保存哈希；密码不一致、长度不合法或取消时不会修改配置。命令保留其他配置字段及文件属主，将文件权限设为 `0600`，需要配置所在目录可写。运行中的同配置服务会立即应用新密码并使旧会话失效；未运行的配置在下次启动生效。若提示已保存但无法应用，需重启该服务；Docker 的只读配置挂载需在宿主机更新后重启容器。

## 前台与后台运行

```bash
pmem start
pmem start -d
pmem start -d -c /path/to/pmem.json
pmem stop
```

每个系统用户只运行一个服务。前台用 Ctrl+C 停止；后台关闭终端后继续运行，使用 `pmem stop` 停止，且停止时不需要原配置文件。后台日志为 `~/.pmem/pmem.log`，服务记录为 `~/.pmem/pmem.pid`。启动命令在服务真正开始监听后才报告成功。异常退出留下的记录可用 `pmem stop` 清理，再重新启动。停止命令通过带随机凭据的本机控制连接请求服务关闭，不会仅凭 PID 发送信号。

daemon 不提供自动重启或开机启动；需要时用系统服务管理器运行前台 `pmem start`，或使用下方 Docker 的重启策略。

访问 `http://localhost:3000`。默认本地正文在 `~/.pmem/data/notes/<UUID>.md`；只有 Markdown 内容，没有页面 HTML 或 JSON 外壳。`dataDir` 可指定专用目录，操作系统用户必须有创建、替换、删除及 fsync 权限。不要通过符号链接提供 notes 目录。推荐本机 SSD 文件系统，不承诺网络文件系统的原子发布语义。

源码开发：`corepack enable`、`pnpm install --frozen-lockfile`、`pnpm build`，再 `pnpm start`。开发 Web 时另开终端运行 `pnpm dev:web`，把 JSON 的 `origin` 改为 `http://localhost:5173`，服务端运行 `pnpm dev`。配置参数可以追加到启动命令，例如 `pnpm start -c /path/to/pmem.json`。

## 容器：本地与 OSS 二选一

需要 Docker 和 Compose。镜像以 UID/GID 1000 的 `node` 用户运行。将 `pmem.example.json` 复制为 Compose 同目录的 `pmem.json`，填好账号、哈希和密钥，并设置 `host` 为 `0.0.0.0`、`port` 为 `3000`、`dataDir` 为 `/data`、`stateDir` 为 `/state`。配置以只读文件挂载到 `/config/pmem.json`；宿主机文件须允许 UID 1000 读取（例如更改属主为 1000 后设为 600）。不要放宽为全局可读。

`storage` 为 `local` 时：

```bash
docker compose --profile local up -d --build
docker compose --profile local logs --tail 30
```

OSS 模式改为 `"storage": "oss"` 并填写 `oss` 参数，使用 `oss` profile。Compose 将专用 `notes` 命名卷挂在 `/data`；OSS 服务使用另一个 `state` 命名卷挂在 `/state`。不要同时启用两个 profile，不要扩容服务，也不要执行会删除数据卷的清理命令。使用宿主机 bind mount 时预先创建目录并赋予 UID 1000 读写权限。示例只向宿主机回环地址发布端口。

公开访问必须配置 HTTPS 和 ``origin` 为 `https://你的域名``。例如宿主机 Caddy：

```caddyfile
notes.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Web/API 同源，不直接公开 OSS。外部 HTTP Origin 默认在启动时被拒绝，可信网络内的例外见下一节；本机 loopback HTTP 仅供开发。应用提供 HttpOnly、SameSite=Strict 会话 Cookie、Origin/CSRF 检查和登录限流（每个连接来源每 15 分钟 10 次）；反向代理下该额度由代理来源共享，适合单人部署。代理应允许至少 1 MiB 请求体，不缓存 `/api/`。构建产物含预压缩资源，应用按 Accept-Encoding 返回 gzip；HTML 不使用长缓存。

## 可信网络内使用 HTTP

默认只接受 HTTPS Origin。家庭内网、NAS、VPN 等链路本身可信或已加密的场景，可以由部署者显式放行明文 HTTP：

```json
{
  "allowInsecureHttp": true,
  "origin": "http://192.168.1.10:3000",
  "host": "0.0.0.0"
}
```

将以上字段合入现有配置。

- 只有布尔值 `true` 生效，且只影响非回环的 HTTP Origin；HTTPS 与本机 loopback 的行为不变。未设置时启动失败，错误信息会提示该开关。
- 启动日志输出一行 `WARNING`。此时密码和会话 Cookie 以明文传输，同一网络上的其他人可以截获；不要用于公网。
- `origin` 必须与浏览器地址栏的协议、主机和端口完全一致，否则写入请求会被 Origin 校验拒绝。
- 直接运行 Node 时把 `host` 改为内网地址或 `0.0.0.0`。Compose 示例只向宿主机回环地址发布端口，需把 `ports` 改为要监听的内网地址。
- 浏览器把非 localhost 的 HTTP 页面视为不安全上下文，没有 Web Locks，草稿槽位因此降级：每次加载页面分配新的草稿槽位，刷新或关闭前尚未同步的草稿需从「本机草稿」恢复；恢复后原记录不会自动回收，确认不再需要后手动丢弃，丢弃时无法判断它是否仍被另一个标签页使用。

## OSS 初始化与权限

使用独立的私有 Bucket，地域例如 `oss-cn-hangzhou`。Bucket 必须**从未启用版本控制**；Enabled、Suspended 或读取版本状态失败都会拒绝启动。默认不配置 `oss.prefix`，笔记保存为 Bucket 根目录下的 `notes/<UUID>.md`，部署身份标记为 `control/state-owner`。填写配置中的 `oss` 对象：

```json
{
  "bucket": "your-private-bucket",
  "region": "oss-cn-hangzhou",
  "accessKeyId": "your-access-key-id",
  "accessKeySecret": "your-access-key-secret"
}
```

RAM 凭据只在服务端使用；不要使用主账号密钥。

`oss.prefix` 可省略或设为空字符串；需要在 Bucket 内隔离存储时才显式设置，例如 `"prefix": "personal/"`。非空值必须是以 `/` 结尾的简单相对路径，此时对象键为 `personal/notes/<UUID>.md` 和 `personal/control/state-owner`。

部署在与 Bucket 同地域的阿里云 ECS 上时，建议将上述 `region` 字段替换为 `"endpoint": "https://oss-cn-hangzhou-internal.aliyuncs.com"`（按实际地域替换），让初始化、版本检查和所有笔记读写使用 OSS 内网，无需再填写 `region`。内网访问可减少公网延迟波动，且不产生公网流量费用；部署环境必须能够路由到该内网地址，普通本机或其他云服务器通常无法直接访问。[阿里云访问域名说明](https://www.alibabacloud.com/help/zh/oss/user-guide/access-oss-via-bucket-domain-name)。

`oss.region` 和 `oss.endpoint` 至少填写一个。只填 `region` 时使用该地域的公网地址；只填 `endpoint` 时直接使用指定地址；两者都填时优先使用 `endpoint`。显式填写的字段必须有效，空字符串不等于省略。`endpoint` 接受不带协议的主机名或 HTTPS 地址，统一使用 HTTPS；不要填写 Bucket 名称前缀、对象路径、凭据、查询参数或片段。内网连接失败会报告错误，不自动切回公网。修改 endpoint 后重启服务即可应用，无需重新初始化状态卷；`pmem init-oss` 和真实 OSS 集成测试也使用同一配置。

以下策略对应默认无前缀配置，将 `YOUR_BUCKET` 换为实际值。若显式配置了 `oss.prefix`，在策略中的 `notes/` 和 `control/` 前加上该前缀。应用仅列举笔记，不需要控制台列出所有 Bucket 的权限。HEAD 使用 `oss:GetObject`；ListObjectsV2 使用 Bucket 级 `oss:ListObjects` 加 `oss:Prefix` 条件；版本检查需要独立的 Bucket 级权限。依据：[OSS 授权操作与条件](https://www.alibabacloud.com/help/en/oss/user-guide/authorization-syntax-and-elements)、[前缀访问策略](https://www.alibabacloud.com/help/en/oss/user-guide/access-control-base-on-ram-policy)。

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
      "Condition": {"StringLike": {"oss:Prefix": ["notes/*"]}}
    },
    {
      "Effect": "Allow",
      "Action": ["oss:GetObject", "oss:PutObject", "oss:DeleteObject"],
      "Resource": ["acs:oss:*:*:YOUR_BUCKET/notes/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["oss:GetObject", "oss:PutObject"],
      "Resource": ["acs:oss:*:*:YOUR_BUCKET/control/state-owner"]
    }
  ]
}
```

首次初始化必须使用空 notes 前缀、原状态卷以及停止的应用服务：

```bash
docker compose --profile oss build
docker compose --profile oss run --rm --no-deps pmem-oss node dist/server/cli.js init-oss -c /config/pmem.json
docker compose --profile oss up -d
```

npm 部署则设置 `storage` 为 `oss` 和持久化 `stateDir`，先执行 `pmem init-oss`（可加 `-c`），再 `pmem start`。容器强制 `/state` 独立挂载，Linux 上拒绝 tmpfs/ramfs。状态卷只有身份和待确认操作元数据，不保存笔记正文，不构成第二份正文存储。

初始化先同步本地 `owner.json`，再以禁止覆盖方式创建 `control/state-owner`。若初始化中断，保留原卷、原配置，重新执行初始化；不会生成新身份去覆盖已有标记。标记存在但本地身份缺失或不匹配时，即使显式初始化也会拒绝。启动失败先核对 Bucket、地域、RAM 权限、版本状态、原卷挂载及文件权限，不要删除 pending 记录来“修复”。

每次修改前先同步 pending 记录，OSS SDK 修改请求不自动重试。超时不能证明写入未发生；该笔记保持暂停，后台只能读回核对。读到目标内容或删除目标已不存在才解除；读到旧内容仍暂停。浏览器显示“保存结果待确认”，草稿保留，可复制或以新 ID 另存。服务重启继续遵循原 pending 记录。

正常更新复用 If-Match 校验时读取的正文摘要，每次只需一次完整 GET 和一次 PUT；待确认操作的读回核对另计。若禁止覆盖的创建请求明确返回 OSS `409 FileAlreadyExists`，在 pending 记录删除并完成目录 fsync 后返回 `409 already_exists`，由客户端读回核对并处理冲突。其他异常仍按待确认处理；清理失败也不能报告确定成功或绕过保护。

运行期 5xx 在标准错误输出一行 JSON 诊断。记录 HTTP 请求 ID、路由模板、状态与错误码；OSS 待确认另含笔记 ID、操作 ID、操作类型和阶段。SDK 错误仅提取有界的类名、错误码和 OSS requestId，不打印原始 message、stack、响应对象、URL、请求头、凭据或正文。操作 ID 对应 pending 文件的 `requestId`，可与 OSS requestId 一起辅助排查：

| `stage` | 排查方向 |
| --- | --- |
| `pending_record` | 本地状态记录未能可靠落盘，检查状态卷空间、权限和 I/O；尚未发出本次 OSS 修改 |
| `oss_request` | 修改请求失败或响应丢失；通过错误码及 OSS requestId 检查网络、RAM 权限或云端请求结果 |
| `pending_clear` | 请求结束后或读回确认后的状态清理失败，检查状态卷 I/O / fsync |
| `pending_verify` | 读回失败，或 `TargetNotObserved` 表示尚未读到目标结果；后者没有可关联的新 OSS 错误 requestId |

容器用 `docker compose --profile oss logs --tail 100` 查看；直接运行 Node 时保留标准错误输出。`storage_unavailable` 的其他 5xx 同样记录有界错误标识。日志用于定位原因，不能据此删除 pending 或自动重放未知修改；仍按读回核对或下文隔离恢复流程处理。

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

## 浏览器保存恢复与后续事项

多标签页重新登录后，认证阻塞先读取当前会话、更新 CSRF 再恢复；写入明确返回 `403 csrf_rejected` 时更新会话并最多重试一次。其他 403（例如 Origin 不匹配）不会通过刷新令牌绕过。写入 429 的重试时间、次数和操作类型随当前草稿持久化，遵守 `Retry-After`，并采用 1 秒起、上限 60 秒的指数退避；刷新页面或继续输入不会跳过等待。未知写入仍只读核对，不能当作限流自动重放。

待办：评估 IndexedDB 不可用时的“仅远端保存”模式。本期继续在本机持久化提交状态后发送，失败时保留内存文字、支持复制和重试本机保存。直接跳过持久化会丢失刷新后的在途操作信息，必须先定义未知提交、离线、重载与状态提示的保证，再单独实现和验证；本轮不启用该模式。
