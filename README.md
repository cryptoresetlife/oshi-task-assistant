# Oshi Task Assistant · Oshi 任务助手

在 Windows 本机运行的 Oshi 任务助手，支持普通 Chrome 和兼容的 Chrome 多开环境。可提前填写回复或通过自己配置的模型生成回复，收集真实回复链接并提交到 Oshi。

这是社区工具，与 Oshi Labs、X 或 Google 无隶属关系。

## 功能

- 启动独立的普通 Chrome，首次登录后复用本机登录状态。
- 连接已开启调试的本机 Chrome；兼容 Chrome 多开管理器的环境配置。
- 读取任务，执行评论、点赞、关注和转帖；其他类型标记为手动任务。
- 默认先预览回复，支持逐条编辑，也可选择直接发布。
- 核对 X 与 Oshi 账号，验证回复作者和原帖关系，保存真实回复链接。
- 提交中断后续交已有链接；发布结果不确定时停止，避免重复回复。
- 空闲时切换环境，执行记录按环境及账号隔离。

## 快速开始

需要 Windows、[Google Chrome](https://www.google.com/chrome/) 和 [Node.js 22 或更新版本](https://nodejs.org/)。

### 使用下载包

1. 从 [Releases](https://github.com/cryptoresetlife/oshi-task-assistant/releases) 下载 Windows ZIP 并解压。
2. 双击 `启动助手.cmd`，打开 <http://127.0.0.1:18744/>。
3. 点击 **启动普通 Chrome**，在新窗口登录 Oshi 和 X，使用同一账号。
4. 回助手点击 **连接环境**，填写回复内容或模型配置，再勾选任务运行。

首次登录需要自己完成。Chrome 数据保存在 `%LOCALAPPDATA%\OshiTaskAssistant\Chrome`；正常关闭或升级助手不会清除它，网站会话过期后需重新登录。此环境独立于日常 Chrome，不复制已有浏览器的登录数据。

### 从源码运行

```powershell
git clone https://github.com/cryptoresetlife/oshi-task-assistant.git
cd oshi-task-assistant
npm ci --ignore-scripts
npm start
```

不需要下载 Playwright 自带的浏览器。使用本机 Google Chrome。

## 连接其他环境

**普通 Chrome：** 使用“启动普通 Chrome”按钮即可。重复启动会复用运行中的同一环境。日常默认配置的 Chrome 不能直接用调试端口接管，见 [Chrome 官方说明](https://developer.chrome.com/blog/remote-debugging-port)。

**已有调试端口：** 展开“连接已开启调试的本机 Chrome”，输入端口后添加。仅接受本机连接。

**Chrome 多开管理器：** 先在原管理器启动 Chrome，再刷新环境列表。默认读取 `%APPDATA%\ChromeManager\profiles.json`，不包含或分发原管理器。运行时关闭鼠标键盘同步。

兼容配置示例：

```json
[{ "id": 1, "name": "环境 1", "debugPort": 19001 }]
```

未指定 `debugPort` 时，使用 `19000 + id`。新环境连接失败会保留当前环境；运行中或等待回复确认时，先停止再切换。

## 回复设置

- **提前填写：** 填写默认回复，或给每条评论单独填写。
- **自动生成：** 配置 Chat Completions 兼容接口完整地址、模型名称及 API Key，可使用本机模型接口。原帖正文及回复要求会发送到该接口，费用由对应服务商收取。
- 默认逐条预览；勾选“准备好回复后直接发布”才会直接发送。页面重新加载后，此选项恢复为未勾选。
- 回复上限为 140 个 Unicode 字符；任务间隔可设置为 5–300 秒。

## 记录与恢复

记录保存在运行目录的 `data/history.json`。升级时保留该文件，不要在发布结果不确定时删除记录后重跑。

1. 取得回复链接后立即保存。
2. 后续提交失败时，使用“只续交此链接”，不重新发布。
3. 未取得链接且发送结果不确定时，到 X 核对该回复，在记录中补填真实链接。
4. 只有 Oshi 把对应任务列入已完成分组，才记为“已提交完成”。

停止在下一步操作前生效，已经发出的操作不会撤回。

## 数据与限制

- 服务仅监听 `127.0.0.1`，拒绝跨站操作请求，操作接口使用随机令牌。
- API Key 不保存到磁盘或日志；普通偏好存于当前浏览器的 localStorage。
- 本机执行记录、Chrome 登录环境、连接配置均不在源码和发布包内。
- 不处理验证码、登录、奖励领取或钱包操作；需要人工处理时暂停。
- 网站界面变化可能导致定位失败。请只用于自己有权操作的账号，并遵守相关平台规则。

## 开发

```powershell
npm ci --ignore-scripts
npm test
```

31 项测试覆盖链接校验、账号一致性、发布去重、断点恢复、关注按钮识别、环境切换和普通 Chrome 启动。GitHub Actions 在 Windows / Node.js 22、24 上运行测试。

已经在真实页面验证评论链接续交、关注完成提交、环境切换和普通 Chrome 启动。单元测试不能保证第三方页面的后续兼容性；模型服务及完整操作组合未覆盖全部实测场景。

| 文件 | 用途 |
| --- | --- |
| `server.mjs` | 本机 HTTP 服务 |
| `engine.mjs` | 队列、账号隔离与恢复 |
| `browser.mjs` | Oshi / X 页面操作 |
| `chrome.mjs` | 普通 Chrome 启动与检测 |
| `core.mjs` | 校验、记录及模型调用 |
| `public/` | 操作界面 |
| `test/` | Node.js 测试 |

可选环境变量：`OSHI_PORT`（默认 18744）、`OSHI_DATA_DIR`（记录目录）、`OSHI_PROFILES_FILE`（多开配置路径）。自定义端口后请手动访问相应地址；Windows 启动脚本默认打开 18744。

## 许可证

[MIT](LICENSE)。Playwright Core 为 Apache-2.0 许可，参见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
