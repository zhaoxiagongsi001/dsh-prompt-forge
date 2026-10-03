# 每次发版都要做：预构建 tarball

插件市场的收录条目通过 `tarball:` 字段指向一个**预构建包**，让用户跳过源码构建。
本仓库的条目指向：

```
https://github.com/zhaoxiagongsi001/dsh-prompt-forge/releases/latest/download/dsh-prompt-forge.tgz
```

## 为什么这个文件必须叫这个名字

`latest/download/` 只在**请求时**解析 `latest`，文件名是**照字面取的**。
所以资产名里**不能带版本号**：一旦叫 `dsh-prompt-forge-0.2.1.tgz`，
提交当天能下，你下一次发版（比如 0.2.2）就会立刻 404 —— 而且不会有任何人察觉，
包括你自己。维护者文档把这种情况叫做「quiet rot」。

结论：资产名**永远**是 `dsh-prompt-forge.tgz`，版本信息只在包内的 `package.json` 里。

## 发版清单

1. 改 `package.json` 与 `package-lock.json` 的 version，提交、打 tag、push
2. `npm pack`（或下面的命令），把产物**重命名为 `dsh-prompt-forge.tgz`**
3. **上传到新 tag 的 Release**（漏了这步，市场那个下载链接就 404 了）
4. 核对两个 URL 都能下、且 SHA256 与本地一致

## 命令（本机）

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$env:npm_config_cache = "D:\DSH\dsh-prompt-forge\.npm-cache"   # 沙箱下必须改缓存位置

cd D:\DSH\dsh-prompt-forge
& $node node_modules/typescript/bin/tsc --noEmit   # 类型检查
& $node scripts/build.mjs                          # 构建（产物须与 tag 一致）
npm pack --pack-destination D:\DSH\_pack --ignore-scripts

# 版本号必须从文件名里去掉
Copy-Item D:\DSH\_pack\dsh-prompt-forge-<版本>.tgz D:\DSH\_pack\dsh-prompt-forge.tgz
```

上传用 GitHub 的 release-assets 接口：

```
POST https://uploads.github.com/repos/<owner>/<repo>/releases/<releaseId>/assets?name=dsh-prompt-forge.tgz
Authorization: Bearer <token>
Content-Type: application/gzip
```

`<releaseId>` 从 `GET /repos/<owner>/<repo>/releases/tags/<tag>` 取。令牌用
`git credential fill`（`protocol=https` / `host=github.com`）现取现用 ——
**不要写进任何文件，也不要提交进仓库**。

上传后必须核验两个 URL 都能下、且 SHA256 与本地 tarball 一致：

```
https://github.com/<owner>/<repo>/releases/latest/download/dsh-prompt-forge.tgz
https://github.com/<owner>/<repo>/releases/download/<tag>/dsh-prompt-forge.tgz
```

## 发版前自检

- `lib/` 重跑 `scripts/build.mjs` 后必须与 tag 逐字节一致（否则打包内容和源码不符）
- 292 项自检全绿（smoke 48 + host-check 29 + render-check 215）
- 解包后 `lib/index.js`、`lib/client.js`、`cordis.patch.yml`、`package.json` 与仓库内文件 SHA256 相同
- `dsh.bundle` 与 `dsh.client` 仍在 `package.json` 里（收录门槛就卡这一条）
- 包内不得出现 `node_modules/`、`.npm-cache/`、`.refs/` 等开发期目录
