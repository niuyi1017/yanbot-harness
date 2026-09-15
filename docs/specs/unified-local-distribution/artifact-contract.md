# 平台制品与受管启动契约 v1

状态：T1 固定的契约已进入 preview.3 开发实现；本机测试签名、解包、resolver/IPC 与真实包安装已验证，**不表示生产签名或跨平台完整生命周期已认证**。与 [design](design.md) 同属已确认方案的实施细化；验证发现不适用时先修订本契约并记录原因，不能静默放宽限制。跨平台格式/性能和 containment 仍需独立验证。

## 1. 平台包布局与身份

```text
runtime-<os>-<cpu>@V/
  package.json
  runtime-manifest.json
  runtime-manifest.sig
  files.json
  payload/runtime.tar.gz
  LICENSE
  THIRD_PARTY_NOTICES
  sbom.json
```

`package.json` 不含生命周期脚本，按 OS/CPU（Linux 加 glibc）过滤；仅提供数据 export：`./manifest` → `./runtime-manifest.json`。resolver 从自己的模块位置解析该 export，以其所在目录定位固定相对文件，不执行平台包 JS。manifest 与平台 package.json 的 name/version/os/cpu/libc 必须一致；meta、local、sdk、contracts 和平台包属于同一精确发布版本 V。内部私有包保留其实际构建版本，在 SBOM 中记录，不强制假装全部为 V。

manifest 为 UTF-8 JSON，无 BOM、无重复键、禁止未知字段；生成时按下列字段顺序输出两空格缩进与末尾 LF。消费者先按大小上限读取原始字节，对原始字节验签，不以重序列化结果替代签名输入。

| 字段                                | 类型与约束                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                     | 数字 `1`                                                                                                       |
| `packageName` / `version`           | 固定映射中的平台包名 / 精确 SemVer V，无范围与本地路径                                                         |
| `sourceCommit` / `sourceLockSha256` | 40 位小写 Git commit / 构建前后相同的根 lock SHA-256                                                           |
| `target`                            | `{ os, cpu, libc }`；仅 darwin/arm64/null、win32/x64/null、linux/x64/glibc                                     |
| `nodeRange`                         | 首轮 `>=22.22.0 <23`；实际 Node 版本及目标必须验证                                                             |
| `protocolVersion`                   | 公共 contracts 的 `HARNESS_PROTOCOL_VERSION`，当前为 `1.0.0`                                                   |
| `managedProtocolVersion`            | 数字 `1`，不得退化成旧显式路径等级                                                                             |
| `sdkVersion`                        | 精确 V；与公共协议兼容校验分别执行                                                                             |
| `entryPath`                         | 固定 `dist/main.js`，必须是文件清单内普通文件                                                                  |
| `payload`                           | `{ path: "payload/runtime.tar.gz", size, sha256 }`                                                             |
| `fileList`                          | `{ path: "files.json", size, sha256, entryCount }`                                                             |
| `materials`                         | 按 LICENSE、THIRD_PARTY_NOTICES、sbom.json 顺序的 `{ path, size, sha256 }` 数组，恰好三项                      |
| `adapters`                          | 按 adapterId 排序的 `{ adapterId, packageName, version }` 数组，精确记录已装配 Adapter；不得把存在误写成已认证 |
| `keyId`                             | 受信配置登记的发布密钥标识；manifest 不携带可自动信任的公钥                                                    |

所有 SHA-256 为 64 位小写 hex，所有 size/count 为非负安全整数。签名算法固定 Ed25519；`runtime-manifest.sig` 是 64 字节原始签名，覆盖整个 manifest 原始字节。固定在受信 meta 中的 keyId→公钥映射必须同时适用于预期发布渠道；未知 keyId、签名错误、版本/target/摘要不匹配直接拒绝。测试密钥只用于隔离探针，不能成为生产 fallback。正式信任根、轮换和撤销由 T5 落地。

## 2. 归一化与逐文件清单

候选目录仅允许删除下列 pnpm 元数据；遇到额外虚拟 store 文件必须失败，不递归删除未知内容：

```text
pnpm-lock.yaml
pnpm-workspace.yaml
node_modules/.modules.yaml
node_modules/.package-map.json
node_modules/.pnpm-workspace-state-v1.json
node_modules/.pnpm/lock.yaml
```

只归一化工作区登记的自有 package.json：删除 devDependencies/scripts/packageManager/pnpm/publishConfig 及 `_id/_from/_resolved/_integrity/_where`；将已安装的 dependencies/optionalDependencies/peerDependencies 改为实际精确版本。缺失的必需依赖、本地第三方 selector、版本漂移直接失败。允许未安装的非本地 optional 依赖保持 selector，记录其缺失；别名依赖需另行设计。第三方 manifest、许可证、代码及嵌入 CLI 不变字节；清理不能代替厂商许可审查。

`files.json` 在 archive 外部，避免自引用：只描述 payload 内部文件和目录，不包含平台包的 manifest/signature/materials。格式为紧凑 JSON `{ "schemaVersion": 1, "entries": [...] }`（实际不含展示空格），UTF-8 无 BOM，末尾单个 LF。entries 按原始 POSIX 相对路径的 JS 字符串顺序升序；固定字段顺序如下：

```ts
type DirectoryEntry = { path: string; type: 'directory' };
type FileEntry = { path: string; type: 'file'; size: number; sha256: string; executable: boolean };
```

archive entries 与清单一一对应，包括目录；无额外根目录 `./`、无尾斜线别名、无重复路径。拒绝绝对路径、空/`.`/`..` 段、反斜杠、控制字符、冒号/ADS、Windows 保留名、尾点/空格及 NFC+小写折叠碰撞。不静默重命名路径。禁止符号/硬链接、设备/FIFO、稀疏文件、扩展头覆盖路径；构建器与解包器必须对同一限制进行对抗测试。文件 mode 仅普通 0644/可执行 0755，目录不信任 archive 权限，在私有缓存内按平台安全策略建立；Windows 不依靠 POSIX mode 代替 ACL。

T1c 使用逐文件允许差异集验证第三方字节与可执行标志未变，再独立比较忽略 manifest 字节后的包资源/实际依赖上下文。本次仓库/真实路径与临时装配根在所有文件（含大文件/二进制）的 UTF-8/UTF-16LE 内容中扫描；通用 home 前缀不足以证明构建泄漏，见 decision-record 的上游 ripgrep 构建路径证据。常见凭据模式命中直接失败且不打印匹配值。该扫描不是任意编码或所有凭据类型的完备检测，来源/许可仍需人工审核。

## 3. 候选资源上限与展开验证

| 对象                | v1 候选上限   |
| ------------------- | ------------- |
| manifest            | 64 KiB        |
| signature           | 恰好 64 bytes |
| files.json          | 2 MiB         |
| 单个 materials 文件 | 8 MiB         |
| 压缩 payload        | 128 MiB       |
| 展开总文件字节      | 512 MiB       |
| 单个展开文件        | 256 MiB       |
| 文件加目录 entry 数 | 100,000       |
| 单路径 UTF-8 字节   | 1,024         |

这是基于本机约 163 MiB 候选目录的保守安全预算，**不是其他平台已通过的大小认证**。T1c 目录探针执行展开大小、单文件、entry、路径、清单限制；T1d 增加本机 gzip/tar 受限流和攻击样例，材料读取上限仍待产品校验器实现。超限阻断构建/启动，禁止调用方自动扩大上限；确需调整时必须有目标平台数据和显式契约修订。Windows 实际路径支持还取决于 cacheRoot 全长，不承诺所有 1,024 字节路径都能创建。

目标产品校验顺序：受限读取与验签 → 包身份/Node/协议 → 校验 materials 和 fileList 的字节摘要/严格结构 → 有界流式校验 payload 压缩摘要 → 排他锁/私有临时目录 → 逐 entry 受限展开与校验 → 无多余或缺失 entry → 原子提交 cache。tar 库本身可执行的写入不能先于应用层路径/type/大小检查；终止、超时或校验失败不得提交半成品。T1d 本机已验证第 6 节的受限解析和失败清理；正式信任、共享缓存提交和跨平台证据仍待后续实现。

## 4. Resolver 与单一启动期限

```ts
type ManagedRuntimeResolver = (context: { signal: AbortSignal }) => Promise<{
  entryPath: string;
  runtimeVersion: string;
  protocolVersion: string;
  managedProtocolVersion: 1;
}>;
```

保持设计中的最小注入类型；signal 承载整次启动的剩余期限，不引入跨进程墙钟时间戳。默认 15 秒，既有可配范围 100–120,000 ms，覆盖 Node 检查、resolver、锁等待、读/展开/验签、spawn、IPC、descriptor 和 health/profile。超时/取消后不得迟到 spawn 或提交 cache；可取消 I/O 和每个提交点都要检查 signal。

自定义 Node 先验证版本/OS/CPU；v1 仅接受与宿主相同的 OS/CPU，异架构注入直接拒绝，不能误用宿主目标。自定义 resolver 结果也必须与最终 Runtime 握手一致。显式路径 → 环境路径 → 注入 resolver → local 默认 resolver 的顺序保持不变，高优先级失败不 fallback；旧 SDK 无 resolver 保持原错误。

## 5. 私有 managed IPC v1

独立 Node IPC 通道只传普通 JSON 对象；每条按 UTF-8 JSON 计不超过 8 KiB，拒绝未知字段/消息类型、错误方向或序列。公共 HTTP/SSE/descriptor schema 1 不变，不通过 IPC 传 token、Key、环境、业务数据或任意路径。

| 顺序/方向               | 消息字段（所有消息含 `managedProtocolVersion: 1`）                              |
| ----------------------- | ------------------------------------------------------------------------------- |
| 父 → 子，spawn 后一次   | `{ type: "hello", launchId }`，launchId 为父生成 UUID                           |
| 子 → 父，服务就绪后一次 | `{ type: "ready", launchId, pid, instanceId, runtimeVersion, protocolVersion }` |
| 父 → 子，关闭时         | `{ type: "shutdown", launchId, requestId }`，requestId 为 UUID                  |
| 子 → 父，正常清理后     | `{ type: "shutdown-complete", launchId, requestId, pid, instanceId }`           |

ready 的 pid 必须等于 owned ChildProcess.pid；instanceId 必须与该实例 descriptor 一致；版本与受信 resolver 结果一致，随后仍验证 health/profile。Runtime 只在 managed 启动模式等待 hello，普通 Daemon 不启用父死亡策略。ready 之前可以 shutdown；此时子完成启动中止后退出，不要求发送带未建立 instanceId 的完成消息。父 IPC 断开触发同一有界清理路径，无可写通道时不尝试 ACK。重复 close 共用同一个 Promise/requestId，子端 shutdown 幂等，未知 launchId 不接管任何实例。

ACK 仅表示子端正常关闭步骤结束，不证明进程或厂商孙进程已退出。父端必须等待 owned 树退出，宽限后进行平台有界回收；全局 shutdown timeout 延续默认 5 秒/可配 100–30,000 ms，并预留强制回收预算。失败返回 CLEANUP_FAILED，不能先删除仍使用中的状态。PID 复用、Windows Job Object/ACL、POSIX 脱组后代、父崩溃时 watchdog 等仍由 T4 验证；只实现 IPC 不足以声称整树回收保证。

## 6. T1d 解包候选与格式边界

选定探针依赖 `tar-stream@3.2.1`（MIT），仅加入根 devDependencies，传递依赖由根 lock 固定；不改变 SDK/Runtime 的生产依赖。复用其公开 pack/extract 流 API，不使用 tar-fs/系统 tar 的文件系统写入器。Node 22 的 zlib 负责 gzip/DEFLATE；本机源码与包完整性、回归结果必须记录。库升级需要重跑攻击样例，不能只改版本。

首版限定 USTAR 普通文件/目录、清单顺序、零 uid/gid/mtime、空 owner/link/device 字段、确定 mode、零 padding 和恰好两个结束块。在 tar-stream 前按 512-byte framing 检查这些字段及 checksum，并用已验证清单限定每一项路径/长度；PAX/GNU/稀疏/其他类型在送入库之前拒绝，防止扩展头被库消费后无法审计。现有平台候选目录需要实测可由该子集表达；tar-stream 对非 ASCII 内部资源名或过长 USTAR 路径会输出 PAX，构建探针必须失败，不能改名或偷偷放行。**解包目标目录仍支持中文/空格；任意 UTF-8 内部资源名的打包支持须后续明确设计 PAX 后再声明**。原 1,024-byte 路径上限是安全上限，不承诺所有路径能被首版 builder 表达。

gzip 限定无可选字段的单 member：固定方法/flags/mtime，核对 CRC32、ISIZE，以及 DEFLATE 实际消耗的输入字节，拒绝尾随零/垃圾/拼接 member。验证压缩大小/摘要后先保存至专属临时目录中的快照，再从快照流式展开；压缩体积上限 128 MiB，展开 tar 流上限为清单预测的 header/body/padding/end 总长且受全局上限约束。文件内容按清单逐项流式核验 SHA-256；不把压缩文件摘要等同于已展开文件完整性。

T1d 使用唯一 mkdtemp 容器及独立 staging，只有全部流结束、checksum/清单/摘要通过且 signal 未取消后才 rename 为该容器内的 payload 并返回。失败/超时先终止并等待所有流与写入收口，再删除本次拥有的容器；不得删除输出父目录或其他既有目录。仅在受控探针中以 caller 提供的可信摘要模拟已验签清单，不提供生产未签 fallback；共享缓存锁、Windows ACL 和正式信任根仍属 T3–T5。

备选：node-tar 的完整文件系统提取器更便利，但本切片不需要其链接/扩展格式及权限恢复能力；通用 tar 库的成功解析也不代表符合本项目归档格式。维护者的安全记录提示扩展头、链接、解析资源限制需要独立验证，不据此声称其他库没有漏洞。

选型资料：[tar-stream README](https://github.com/mafintosh/tar-stream)、[extract 源码](https://github.com/mafintosh/tar-stream/blob/v3.2.1/extract.js)、[node-tar advisories](https://github.com/isaacs/node-tar/security/advisories)。

## 7. 尚未解除的门禁

- T1：Mac→Windows/Linux 同一 kit 的真实运行；平台大小、安装布局、路径/权限与冷启动预算。本机受限归档/攻击样例证据见 probe-results。
- T2/T3：正式生成器、严格 schema/签名校验器、缓存锁恢复与权限、取消一致性、resolver 实现。
- T4/T5：双平台生命周期与 ACL、正式信任根/轮换、Registry 和再分发许可。
- 现有 preview.2 仍从原冻结 ref 使用；本契约不允许覆盖同版本制品。
