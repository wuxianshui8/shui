# ============================================================
# NestJS 后端（MySQL 8.4 + Redis）联调验证
# 直接执行：powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-nest.ps1
# 脚本会自行拉起/停止本地 MySQL 与 Redis，不依赖外部服务
# ============================================================
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$nodePath = "$env:PI_SCRATCH_DIR\node\node-v22.14.0-win-x64"
if (Test-Path $nodePath) { $env:Path = "$nodePath;$env:Path" }
$env:NODE_NO_WARNINGS = "1"
$tools = "D:\shui\tools"
$mysql = "$tools\mysql-8.4.0-winx64"
$app = "D:\shui\apps\api-nest"
$BASE = "http://localhost:4300"
$global:pass = 0
$global:fail = 0

function Wait-Port($port, $tries) {
  for ($i = 0; $i -lt $tries; $i++) {
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect("127.0.0.1", $port); $c.Close(); return $true } catch { Start-Sleep -Milliseconds 400 }
  }
  return $false
}
function Check($cond, $name, $extra = "") {
  if ($cond) { $global:pass++; Write-Output ("  [PASS] " + $name + $(if ($extra) { "  " + $extra } else { "" })) }
  else { $global:fail++; Write-Output ("  [FAIL] " + $name + $(if ($extra) { "  " + $extra } else { "" })) }
}

if (-not (Test-Path "$mysql\bin\mysqld.exe")) { Write-Output "未找到本地 MySQL，请先执行 tools/setup-services.ps1"; exit 1 }

Get-Process mysqld, redis-server, node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process -FilePath "$mysql\bin\mysqld.exe" -ArgumentList "--basedir=$mysql", "--datadir=$tools\mysql-data", "--port=3307", "--bind-address=127.0.0.1", "--mysqlx=OFF" -WindowStyle Hidden -RedirectStandardOutput "$tools\m.out.log" -RedirectStandardError "$tools\m.err.log" | Out-Null
Start-Process -FilePath "$tools\redis\redis-server.exe" -ArgumentList "--port", "6380", "--bind", "127.0.0.1" -WorkingDirectory "$tools\redis" -WindowStyle Hidden -RedirectStandardOutput "$tools\r.out.log" -RedirectStandardError "$tools\r.err.log" | Out-Null
$myOk = Wait-Port 3307 40
$rdOk = Wait-Port 6380 20
Write-Output ("依赖服务：MySQL=" + $myOk + " Redis=" + $rdOk)

& "$mysql\bin\mysql.exe" -h 127.0.0.1 -P 3307 -u root --skip-password -e "DROP DATABASE IF EXISTS jiajiao; CREATE DATABASE jiajiao DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;" 2>$null | Out-Null
& cmd /c "`"$mysql\bin\mysql.exe`" -h 127.0.0.1 -P 3307 -u root --skip-password jiajiao < `"$app\db\schema.mysql.sql`" 2>nul" | Out-Null

Push-Location $app
& node "node_modules\typescript\bin\tsc" -p tsconfig.json
Write-Output (& node db\seed-min.mjs 2>&1)
$log = "$env:PI_SCRATCH_DIR\nest.log"
$errLog = "$env:PI_SCRATCH_DIR\nest.err.log"
Start-Process -FilePath "node.exe" -ArgumentList "dist/main.js" -WorkingDirectory $app -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $errLog | Out-Null
Pop-Location
Write-Output ("NestJS 就绪：" + (Wait-Port 4300 30))

try {
  Write-Output "`n=== 1. 健康检查（MySQL + Redis 双链路）==="
  $h = Invoke-RestMethod "$BASE/api/health" -TimeoutSec 10
  Check ($h.data.db.ok -and $h.data.cache.ok -and $h.data.framework -eq "NestJS") "NestJS + MySQL + Redis 全通" ("users=" + $h.data.db.users + " mysql=" + $h.data.db.latencyMs + "ms")

  Write-Output "`n=== 2. 字典与规则（MySQL 权威源 + Redis 缓存）==="
  $dict = Invoke-RestMethod "$BASE/api/meta/dictionary"
  Check ($dict.data.stages.Count -eq 5) "字典接口" ("学段 " + $dict.data.stages.Count + " 科目 " + $dict.data.subjects.Count)
  $r1 = Invoke-RestMethod "$BASE/api/meta/rules-public"
  Check ($r1.data.Count -ge 11) "公开规则读自 MySQL" ($r1.data.Count.ToString() + " 组")
  $keys = & "$tools\redis\redis-cli.exe" -h 127.0.0.1 -p 6380 keys "jiajiao:rules:*" 2>&1
  Check (@($keys).Count -ge 1) "规则写入 Redis 缓存" ("keys=" + @($keys).Count)

  Write-Output "`n=== 3. 鉴权（MySQL 校验口令 + HMAC 令牌）==="
  $bad = $null
  try { Invoke-RestMethod "$BASE/api/auth/login-password" -Method Post -ContentType "application/json" -Body '{"phone":"13900000001","password":"wrong"}' | Out-Null } catch { $bad = $_.Exception.Response.StatusCode.value__ }
  Check ($bad -eq 400) "错误口令被拒" ("HTTP " + $bad)
  $login = Invoke-RestMethod "$BASE/api/auth/login-password" -Method Post -ContentType "application/json" -Body '{"phone":"13900000001","password":"a123456"}'
  Check ($login.data.token.Length -gt 40) "管理员登录成功" ("role=" + $login.data.user.role)
  $me = Invoke-RestMethod "$BASE/api/auth/me" -Headers @{ Authorization = "Bearer " + $login.data.token }
  Check ($me.data.user.id -eq 1) "令牌校验通过" ("nickname=" + $me.data.user.nickname)
  $nt = $null
  try { Invoke-RestMethod "$BASE/api/auth/me" | Out-Null } catch { $nt = $_.Exception.Response.StatusCode.value__ }
  Check ($nt -eq 401) "无令牌 401" ("HTTP " + $nt)
  $tam = $login.data.token.Substring(0, $login.data.token.Length - 3) + "aaa"
  $bt = $null
  try { Invoke-RestMethod "$BASE/api/auth/me" -Headers @{ Authorization = "Bearer " + $tam } | Out-Null } catch { $bt = $_.Exception.Response.StatusCode.value__ }
  Check ($bt -eq 401) "篡改令牌 401" ("HTTP " + $bt)

  Write-Output "`n=== 4. 安全响应头 ==="
  $resp = Invoke-WebRequest "$BASE/api/meta/dictionary" -UseBasicParsing
  Check ($resp.Headers["X-Frame-Options"] -eq "SAMEORIGIN") "X-Frame-Options"
  Check (($resp.Headers["Content-Security-Policy"] -join "") -match "default-src") "CSP"

  Write-Output "`n=== 5. 数据表 ==="
  $tbl = & "$mysql\bin\mysql.exe" -h 127.0.0.1 -P 3307 -u root --skip-password -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='jiajiao';" 2>$null
  Check ([int]$tbl -eq 37) "MySQL 建表完整" ($tbl + " 张表")
} finally {
  Get-Process mysqld, redis-server, node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Write-Output "`n(已停止本地依赖服务)"
}

Write-Output "================================================="
Write-Output ("NestJS 迁移切片验证：通过 " + $global:pass + " 项，失败 " + $global:fail + " 项")
if ($global:fail -gt 0) { exit 1 }