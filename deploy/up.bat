@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 (
  echo [x] 未检测到 docker 命令。请先安装 Docker Desktop 并启动引擎。
  echo     本机虚拟化需先在 BIOS 打开 Intel Virtualization Technology / VT-x，
  echo     并在 Windows 启用 Hyper-V 加虚拟机平台（或 WSL2），否则 dockerd 无法启动。
  exit /b 1
)

if not exist .env (
  copy .env.example .env >nul
  echo [i] 已从 .env.example 生成 .env。
  echo     请把 AUTH_SECRET 填成至少 32 字符的随机串，然后重新运行本脚本。
  echo     生成命令: node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
  exit /b 1
)

echo [1/3] 构建并启动 mysql / redis / app ...
docker compose up -d --build
if errorlevel 1 exit /b 1

echo [2/3] 灌入演示数据 ...
docker compose run --rm seed
if errorlevel 1 exit /b 1

echo [3/3] 服务状态 ...
docker compose ps
echo.
echo 完成: PC 后台 http://localhost:4300/admin-vue/ ，移动端 http://localhost:4300/m/ ，旧 UI http://localhost:4300/parent
endlocal
