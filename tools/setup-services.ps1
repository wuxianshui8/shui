# ============================================================
# 一次性安装本地开发依赖：MySQL 8.4（便携版）+ Redis 5（Windows 移植版）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\setup-services.ps1
# 产物在 D:\shui\tools\ 下，已被 .gitignore 忽略
# ============================================================
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$tools = "D:\shui\tools"
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$mysql = "$tools\mysql-8.4.0-winx64"

if (-not (Test-Path "$mysql\bin\mysqld.exe")) {
  Write-Output "下载 MySQL 8.4.0（约 247MB）…"
  Invoke-WebRequest -Uri "https://cdn.mysql.com/Downloads/MySQL-8.4/mysql-8.4.0-winx64.zip" -OutFile "$tools\mysql.zip" -UseBasicParsing -TimeoutSec 1800
  Expand-Archive "$tools\mysql.zip" -DestinationPath $tools -Force
  Remove-Item "$tools\mysql.zip" -Force
} else { Write-Output "MySQL 已存在，跳过下载" }

$data = "$tools\mysql-data"
if (-not (Test-Path $data)) {
  Write-Output "初始化 MySQL 数据目录…"
  & "$mysql\bin\mysqld.exe" --initialize-insecure --basedir="$mysql" --datadir="$data" --console | Out-Null
} else { Write-Output "MySQL 数据目录已存在，跳过初始化" }

if (-not (Test-Path "$tools\redis\redis-server.exe")) {
  Write-Output "下载 Redis for Windows（约 12MB）…"
  $rel = Invoke-RestMethod "https://api.github.com/repos/tporadowski/redis/releases/latest" -TimeoutSec 60
  $asset = $rel.assets | Where-Object { $_.name -like "*x64*.zip" } | Select-Object -First 1
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile "$tools\redis.zip" -UseBasicParsing -TimeoutSec 600
  Expand-Archive "$tools\redis.zip" -DestinationPath "$tools\redis" -Force
  Remove-Item "$tools\redis.zip" -Force
} else { Write-Output "Redis 已存在，跳过下载" }

Write-Output ""
Write-Output "安装完成："
Write-Output "  MySQL  $mysql\bin\mysqld.exe  （端口 3307，root 无密码，仅监听 127.0.0.1）"
Write-Output "  Redis  $tools\redis\redis-server.exe  （端口 6380）"
Write-Output ""
Write-Output "下一步：node tools\verify-nest.mjs   # 自动起停依赖并验证 NestJS 后端"
Write-Output "说明：以上仅为本地开发/验收用；生产请使用正式 MySQL 8 与 Redis 集群并设置强口令。"