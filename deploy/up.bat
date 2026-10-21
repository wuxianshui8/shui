@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 统一用 call 调用 docker：即便 PATH 里是 docker.cmd 包装器，也不会夺走批处理控制权
where docker >nul 2>nul
if errorlevel 1 (
  echo [x] 未检测到 docker 命令。请先安装 Docker Desktop。
  echo     本机虚拟化需先在 BIOS 打开 Intel Virtualization Technology / VT-x，
  echo     并在 Windows 启用 Hyper-V 加虚拟机平台（或 WSL2），否则 dockerd 无法启动。
  exit /b 1
)

call docker info >nul 2>nul
if errorlevel 1 (
  echo [x] docker 引擎未运行。请启动 Docker Desktop，等状态变 Running 后再运行本脚本。
  exit /b 1
)

call docker compose version >nul 2>nul
if errorlevel 1 (
  echo [x] 未检测到 docker compose（v2 插件）。请升级 Docker Desktop。
  exit /b 1
)

if not exist .env (
  copy .env.example .env >nul
  if errorlevel 1 (
    echo [x] 无法从 .env.example 生成 .env，请检查目录权限。
    exit /b 1
  )
  echo [i] 已从 .env.example 生成 .env。
  echo     请把 AUTH_SECRET 填成至少 32 字符的随机串，然后重新运行本脚本。
  echo     生成命令: node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
  exit /b 1
)

rem 占位符检测: 模板默认值必须被替换，否则等于用公开密钥起生产
findstr /C:"please-change-me" .env >nul 2>nul
if not errorlevel 1 (
  echo [x] .env 里的 AUTH_SECRET 还是模板占位符，必须换成真实随机串（至少 32 字符）。
  echo     生成命令: node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
  exit /b 1
)

echo [1/3] 构建并启动 mysql / redis / app（等待健康检查）...
call docker compose up -d --build --wait
if errorlevel 1 (
  echo [x] 启动失败或服务未在超时内变 healthy。查看: docker compose logs app --tail 40
  exit /b 1
)

echo [2/3] 灌入演示数据 ...
call docker compose run --rm --build seed
if errorlevel 1 (
  echo [x] 演示数据灌入失败。查看: docker compose logs mysql --tail 40
  exit /b 1
)

echo [3/3] 服务状态 ...
call docker compose ps
if errorlevel 1 (
  echo [x] 无法读取服务状态。
  exit /b 1
)
echo.
echo 完成: PC 后台 http://localhost:4300/admin-vue/ ，移动端 http://localhost:4300/m/ ，旧 UI http://localhost:4300/parent
endlocal
