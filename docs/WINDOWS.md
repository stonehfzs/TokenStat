# TokenStat Windows 桌面版

## 安装与日常使用

在 x64 版 Windows 10 或更新版本上运行 `TokenStat-1.5.0-x64-Setup.exe`。安装面向当前 Windows 用户，无需管理员权限，也无需另装 Node.js。安装完成后可从「开始」菜单打开 TokenStat。此构建没有 Authenticode 签名，Windows 可能显示发布者未知。

关闭窗口会释放界面，系统托盘继续显示 TokenStat 并在后台采集本机日志。选择托盘菜单中的「打开 TokenStat」可恢复界面。若 Windows 把图标收进折叠菜单，先点任务栏上的 `^`。要停止后台运行，请从托盘选择「退出 TokenStat」。

自动启动默认关闭。需要时可在「来源 → 桌面设置」或托盘菜单开启「开机自启动」。它只作用于当前用户，登录 Windows 后先进入托盘。也可在 Windows「设置 → 应用 → 启动」中管理此启动项。[Electron 登录项接口](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows) · [Windows 登录启动机制](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys)

桌面数据库位于 `%APPDATA%\TokenStat\data\tokenstat.db`。卸载会移除应用的启动项和快捷方式，保留这份本地数据。

## 与另一台电脑同步

1. 在第一台设备的「来源 → 跨设备同步」中选择两台电脑都能同步的文件夹，填入设备名称，留空「同步密钥」，然后选择「启用并同步」。保存生成的配对密钥。
2. 在第二台设备选择同一共享文件夹在该设备上的本地路径，填入另一设备名称和已有密钥，启用同步。Windows 和 Linux 的本地路径可以不同。

TokenStat 在共享目录写入加密用量快照。各设备分别保留自己的日志目录和 SQLite 数据库。完整配置见[使用说明](../README.md)。

## 从源码构建

在 Windows 上安装 Node.js 22.15 或更高版本，在项目目录执行以下命令。

```powershell
npm ci
npm run dist:win
```

安装包生成于 `dist/`。在 Linux x64 上交叉构建时，可在已安装 Wine 的环境里运行同一命令，也可使用 Electron Builder 的 Wine 构建镜像。

```sh
npm ci
npm run dist:win
```

可选的签名流程在 Electron Builder 中配置。 [NSIS 安装配置](https://www.electron.build/v26/docs/nsis/) · [跨平台构建](https://www.electron.build/v26/docs/features/multi-platform-build/)
