@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22 或更新版本：https://nodejs.org/
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo 请升级到 Node.js 22 或更新版本：https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules\playwright-core\package.json" (
  echo 正在安装所需组件，首次启动需要联网...
  call npm.cmd ci --omit=dev --ignore-scripts
  if errorlevel 1 (
    echo 安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)
start "" "http://127.0.0.1:18744"
node server.mjs
pause
