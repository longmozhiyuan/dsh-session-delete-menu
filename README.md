# dsh-session-delete-menu

给 DeepSeek Harness 侧栏的会话加**两个功能，只有这两个**：

1. **删除对话**：右键菜单里多一项红色「删除对话」，排在原生「归档会话」下面。
2. **多选**：右键「多选…」进入选择模式，点会话行勾选，底部浮条批量「归档 / 取消归档 / 删除」。

原生菜单（`sidebar.workspaces.session.menu.item` 槽）只有 置顶 / 重命名 / 分叉 / 归档 / 复制 Session ID，没有删除；工作区行上的「删除工作区」只是把工作区从列表摘掉，不动磁盘。这个插件补的就是「整段对话真正删掉」和「一次处理好几段」。

不做重命名、置顶、移动、目录操作——那些一概没有。

**完全独立**：不依赖 `dsh-session-manager` 或任何其他第三方插件，删除与归档都由本插件自己的 host 半边实现。

## 它怎么工作

1. 右键某个会话 → 菜单末尾出现红色「删除对话」。
2. 点击后先请求本插件自己的 `/session-delete/api/preview`，确认这个会话在磁盘上有几份记录、当前是否开着。
3. 弹二次确认框，写明**不可恢复**；如果会话正在使用中，会说明删除前会先停掉它。
4. 确认后 `POST /session-delete/api/delete`，host 侧依次：
   - 停掉该会话正在运行的 agent（`cancel` + 有界的 `scope.dispose`）；
   - flush 并 `detach` 会话 store 记录，让所有已连接的前端把这一行移除；
   - 删除 `~/.dsh/sessions/<工作区分组>/<会话id>/` 下的产物目录（会话被移动过时可能有多份，都会删）。
5. 任何一步失败都会 `alert` 具体原因，不会静默。

### 多选

1. 在任意一段对话上右键 → 「多选…」，这段立刻进入选中态，同时底部弹出操作条。
2. 直接点其它会话行即可勾选/取消（选择模式下点行不会再打开会话；行上的「⋯」按钮照常可用）。
3. 操作条按钮：
   - **全选**：选中当前列表里所有可见的会话行；
   - **清空**：取消全部勾选；
   - **归档 / 取消归档**：走宿主 `workspaceRegistry` 的官方归档方法，一次处理所有选中项；
   - **删除**：走本插件自己的删除端点，逐条停 agent、detach、删磁盘目录；
   - **退出多选**：清空选中并收起操作条。
4. 批量操作会逐条执行，某条失败不影响其它条；结束时有失败项会弹窗列出「哪一段、什么原因」。
5. 选中的行会高亮（左侧一条红色竖线 + 红色淡底）。

两个端点都通过 DSH 自己的 `connection.admit` 鉴权，要求 owner 身份，所以不是本机上任何进程都能调。

## 前置条件

- DSH 0.2.1-rc.2（`dsh.compatibility.dshReleases` 里已声明兼容）。
- 不需要其他插件。

## 安装

推荐用脚本（自动备份、幂等、可卸载）：

```powershell
pwsh -File .\install.ps1 -Restart
```

默认装到 `desktop` profile；换 profile 用 `-ProfileName 你的profile名`。

手动安装四步：

1. 把本目录整个复制到
   `%USERPROFILE%\.dsh\profiles\<profile>\plugins\dsh-session-delete-menu\`
   再复制一份到
   `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-session-delete-menu\`
2. 编辑 profile 的 `package.json`，在 `dependencies` 里加一行，值是插件目录的**绝对路径**（Windows 盘符照写，分隔符用 `/`）：
   ```json
   "dsh-session-delete-menu": "file:<插件目录的绝对路径>",
   ```
   不确定路径就运行 `pwsh -File .\install.ps1 -Check`，它会打印应该用的路径。
3. 同一个 `package.json` 里，在 `dsh.profile.bundles` 数组末尾加一项：
   ```json
   "dsh-session-delete-menu"
   ```
4. 完全退出 DSH 再打开。

## 卸载

```powershell
pwsh -File .\install.ps1 -Uninstall -Restart
```

手动卸载：从 `dsh.profile.bundles` 和 `dependencies` 里删掉 `dsh-session-delete-menu`，删除 `plugins\` 与 `node_modules\` 下的同名目录，重启。

## 为什么必须进 bundles

`profiles\<profile>\cordis.yml` 是 DSH 启动时**重新生成的产物**，手改会被覆盖——写进去也会在下次启动时消失。

第三方插件真正生效靠两处：

- profile `package.json` 的 `dsh.profile.bundles` 列表；
- 包内 `cordis.patch.yml`，内容为 `- insert:` 一行注册（本插件已自带）。

DSH 启动时把这些 bundle 的 patch 合并进生成的名册，`cordis.yml` 里就会出现 `- id: dsh-session-delete-menu`。装完想确认是否生效：看 `cordis.yml` 里有没有这行，或者直接在 UI 里右键。

## 风险

- 删除不可恢复，没有回收站，确认框是最后一道闸门。
- 工作区文件夹本身、`storages/workspace.json` 里的工作区记录不会被改动，只是这段对话消失。

## 文件

- `lib/index.js`：host 半边，注册 `/session-delete/api/preview` 与 `/session-delete/api/delete`，实现停 agent、detach、删目录。
- `lib/client.js`：client 半边，向 `sidebar.workspaces.session.menu.item` 注册菜单项与二次确认。
- `cordis.patch.yml`：bundle patch，插入插件行。
- `install.ps1`：安装 / 卸载脚本。
