# 启动本地开发依赖（MySQL 8.4 + Redis 5），已运行则跳过
$ErrorActionPreference = "Stop"
$tools = "D:\shui\tools"
$mysqlHome = "$tools\mysql-8.4.0-winx64"
$mysqlData = "$tools\mysql-data"
$MYSQL_PORT = 3307
$REDIS_PORT = 6380

function Test-Port($port) {
  try { $c = New-Object Net.Sockets.TcpClient; $c.Connect("127.0.0.1", $port); $c.Close(); return $true } catch { return $false }
}

if (-not (Test-Port $MYSQL_PORT)) {
  Start-Process -FilePath "$mysqlHome\bin\mysqld.exe" `
    -ArgumentList "--basedir=$mysqlHome","--datadir=$mysqlData","--port=$MYSQL_PORT","--bind-address=127.0.0.1","--mysqlx=OFF","--console" `
    -WorkingDirectory $mysqlHome -WindowStyle Hidden `
    -RedirectStandardOutput "$tools\mysql.out.log" -RedirectStandardError "$tools\mysql.err.log" | Out-Null
  for ($i = 0; $i -lt 40 -and -not (Test-Port $MYSQL_PORT); $i++) { Start-Sleep -Milliseconds 500 }
}

if (-not (Test-Port $REDIS_PORT)) {
  Start-Process -FilePath "$tools\redis\redis-server.exe" `
    -ArgumentList "--port", "$REDIS_PORT", "--bind", "127.0.0.1", "--save", "" , "--appendonly", "no" `
    -WorkingDirectory "$tools\redis" -WindowStyle Hidden `
    -RedirectStandardOutput "$tools\redis.out.log" -RedirectStandardError "$tools\redis.err.log" | Out-Null
  for ($i = 0; $i -lt 20 -and -not (Test-Port $REDIS_PORT); $i++) { Start-Sleep -Milliseconds 300 }
}

Write-Output ("MySQL 127.0.0.1:" + $MYSQL_PORT + " -> " + (Test-Port $MYSQL_PORT))
Write-Output ("Redis 127.0.0.1:" + $REDIS_PORT + " -> " + (Test-Port $REDIS_PORT))