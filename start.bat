@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NODE_EXE=%~dp0tools\node\node.exe"
if not exist "%NODE_EXE%" (
  echo [错误] 未找到 %NODE_EXE%
  echo         请先运行 tools\setup-services.ps1 准备便携版 Node / MySQL / Redis
  pause
  exit /b 1
)

if not exist "%~dp0apps\api-nest\dist\main.js" (
  echo 首次启动需要编译后端，请耐心等待…
)

"%NODE_EXE%" "%~dp0tools\run.mjs"

echo.
echo 服务已退出。
pause
