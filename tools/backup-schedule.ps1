# ============================================================
# B3 定时备份：安装 / 卸载 / 查询 Windows 计划任务（schtasks，当前用户级，无需管理员）
#
#   任务动作：调用 tools/db-backup.mjs（自带 KEEP 份保留策略），
#   输出追加到 backups\backup.log，任务动作由生成的 backups\backup-run.cmd 承载
#   （这样 node / docker 路径与环境变量都被固定下来，任务计划程序里不会因 PATH 差异失败）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\backup-schedule.ps1 -Action Status
#   powershell -ExecutionPolicy Bypass -File tools\backup-schedule.ps1 -Action Install -Time 02:30 -Keep 14
#   powershell -ExecutionPolicy Bypass -File tools\backup-schedule.ps1 -Action RunNow      # 立即跑一次（校验链路）
#   powershell -ExecutionPolicy Bypass -File tools\backup-schedule.ps1 -Action Uninstall
#
#   前提：Docker Desktop 已启动且容器栈在跑（MYSQL_MODE 会自动探测 docker / host，
#         也可先设 $env:MYSQL_MODE = "docker" 固定下来）。
# ============================================================
param(
  [ValidateSet("Install", "Uninstall", "Status", "RunNow")]
  [string]$Action = "Status",
  [string]$Time = "02:30",
  [int]$Keep = 14,
  [string]$TaskName = "jiajiao-db-backup",
  [string]$NodeExe = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$BackupDir = Join-Path $RepoRoot "backups"
$LogFile = Join-Path $BackupDir "backup.log"
$Wrapper = Join-Path $BackupDir "backup-run.cmd"
$BackupScript = Join-Path $RepoRoot "tools\db-backup.mjs"

function Invoke-SchTasks {
  # PS 5.1 两个坑叠加：
  #   ① $ErrorActionPreference = "Stop" 时原生命令的 stderr 会变终止错误（NativeCommandError）；
  #   ② 改成 "SilentlyContinue" 后错误记录被直接丢弃 → 「失败但没有任何原因」，无法排查。
  # 修法：经 cmd /c 把 stderr 并进 stdout，拿到纯文本；退出码仍由 $LASTEXITCODE 判定。
  $parts = @("schtasks.exe")
  foreach ($a in $args) {
    $s = [string]$a
    if ($s -match "\s") { $s = '"' + $s + '"' }
    $parts += $s
  }
  $cmdLine = ($parts -join " ") + " 2>&1"
  $lines = @(& cmd.exe /c $cmdLine | ForEach-Object { $_.ToString() })
  return [pscustomobject]@{ Code = $LASTEXITCODE; Text = (($lines -join " ").Trim()); Lines = $lines }
}

function Resolve-NodeExe {
  if ($NodeExe) {
    if (-not (Test-Path $NodeExe)) { throw "指定的 node 不存在：$NodeExe" }
    return (Resolve-Path $NodeExe).Path
  }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $portable = Join-Path $RepoRoot "tools\node\node.exe"
  if (Test-Path $portable) { return $portable }
  throw "找不到 node.exe：请用 -NodeExe 指定，或把便携版放到 tools\node\node.exe"
}

function Resolve-DockerExe {
  if ($env:DOCKER_BIN -and (Test-Path $env:DOCKER_BIN)) { return $env:DOCKER_BIN }
  $guess = Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin\docker.exe"
  if (Test-Path $guess) { return $guess }
  $cmd = Get-Command docker -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return ""
}

function Write-Wrapper {
  $node = Resolve-NodeExe
  $docker = Resolve-DockerExe
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("@echo off")
  $lines.Add("rem 由 tools/backup-schedule.ps1 生成，请勿手工修改（重新 -Action Install 会覆盖）")
  $lines.Add("setlocal")
  # 统一输出编码为 UTF-8：node 的 stdout 恒为 UTF-8，cmd 端 echo 也必须同码，
  # 否则备份日志里会混入 GBK 字节，事后按 UTF-8 读就是乱码。
  $lines.Add("chcp 65001 >nul")
  $lines.Add(('set "KEEP=' + $Keep + '"'))
  if ($docker) { $lines.Add(('set "DOCKER_BIN=' + $docker + '"')) }
  $lines.Add(('echo [%DATE% %TIME%] backup start >> "' + $LogFile + '"'))
  $lines.Add(('"' + $node + '" "' + $BackupScript + '" >> "' + $LogFile + '" 2>&1'))
  $lines.Add("set RC=%ERRORLEVEL%")
  $lines.Add(('echo [%DATE% %TIME%] backup exit=%RC% >> "' + $LogFile + '"'))
  $lines.Add("exit /b %RC%")

  # 写 UTF-8（无 BOM）+ 首部 chcp 65001：cmd 逐行解析，ASCII 的 @echo off/chcp 先执行，
  # 之后的行就按 UTF-8 解码，含中文的路径也不会乱；同时满足 windows:check 的编码规则。
  $text = ($lines -join "`r`n") + "`r`n"
  [System.IO.File]::WriteAllText($Wrapper, $text, (New-Object System.Text.UTF8Encoding($false)))
  return $Wrapper
}

function Show-Status {
  $res = Invoke-SchTasks /Query /TN $TaskName /FO LIST /V
  if ($res.Code -ne 0) {
    Write-Output "状态：未安装（任务名 $TaskName）"
    Write-Output "  安装：powershell -ExecutionPolicy Bypass -File tools\backup-schedule.ps1 -Action Install -Time 02:30 -Keep $Keep"
    return
  }
  Write-Output "状态：已安装（任务名 $TaskName）"
  foreach ($line in $res.Lines) {
    if ($line -match "^(任务名|TaskName|下次运行时间|Next Run Time|状态|Status|上次运行时间|Last Run Time|上次结果|Last Result|要运行的任务|Task To Run|计划类型|Schedule Type|开始时间|Start Time)\s*[:：]") {
      Write-Output ("  " + $line.Trim())
    }
  }
  if (Test-Path $LogFile) {
    Write-Output ("  最近日志：" + $LogFile)
    Get-Content $LogFile -Tail 5 -Encoding UTF8 | ForEach-Object { Write-Output ("    " + $_) }
  }
}

switch ($Action) {
  "Install" {
    if ($Keep -lt 1) { throw "-Keep 必须 >= 1（0 表示不剪枝，不适合定时任务）" }
    if ($Time -notmatch "^\d{2}:\d{2}$") { throw "-Time 形如 02:30" }
    $wrapperPath = Write-Wrapper
    $trArg = $wrapperPath
    if ($wrapperPath -match "\s") { $trArg = '"' + $wrapperPath + '"' }
    $res = Invoke-SchTasks /Create /TN $TaskName /TR $trArg /SC DAILY /ST $Time /F
    if ($res.Code -ne 0) {
      $hint = ""
      if ($res.Text -match "Access is denied|拒绝访问") {
        $hint = "`r`n  → 任务计划库写入被拒绝：请用【管理员身份】打开 PowerShell 再执行本命令，或在受限/服务账号会话中改用 Windows 服务管理器手工登记任务动作：" + $Wrapper
      }
      throw ("schtasks 创建失败（退出码 " + $res.Code + "）：" + $res.Text + $hint)
    }
    Write-Output ("✓ 已安装计划任务：" + $TaskName + "（每天 " + $Time + "，保留最近 " + $Keep + " 份）")
    Write-Output ("  任务动作：" + $Wrapper)
    Write-Output ("  备份日志：" + $LogFile)
    Write-Output "  注意：任务运行时 Docker Desktop 必须已启动且容器栈在跑，否则会按 host 模式调便携 mysqldump 并可能失败（日志里会留下 exit 码）。"
    Write-Output "  立即验证链路：powershell -ExecutionPolicy Bypass -File tools\backup-schedule.ps1 -Action RunNow"
  }
  "Uninstall" {
    $res = Invoke-SchTasks /Delete /TN $TaskName /F
    if ($res.Code -ne 0) { throw ("schtasks 删除失败（退出码 " + $res.Code + "）：" + $res.Text) }
    Write-Output ("✓ 已删除计划任务：" + $TaskName)
  }
  "RunNow" {
    $node = Resolve-NodeExe
    if (-not (Test-Path $BackupScript)) { throw "缺少 $BackupScript" }
    $docker = Resolve-DockerExe
    if ($docker) { $env:DOCKER_BIN = $docker }
    $env:KEEP = [string]$Keep
    Write-Output ("立即执行备份（KEEP=" + $Keep + "，node=" + $node + "）")
    & $node $BackupScript
    $rc = $LASTEXITCODE
    if ($rc -ne 0) { Write-Output ("✗ 备份失败，退出码 " + $rc); exit $rc }
    Write-Output "✓ 备份链路可用"
  }
  "Status" {
    Show-Status
  }
}
