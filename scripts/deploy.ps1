# Trien khai production len server "dev" (ssh config) - ban PowerShell.
# Cach dung:
#   .\scripts\deploy.ps1                      # dung HEAD hien tai cua nhanh dang checkout
#   .\scripts\deploy.ps1 -Message "fix: x"    # tu commit het thay doi roi moi deploy
#   .\scripts\deploy.ps1 -NoBuild             # chi restart, khong build lai image
#   .\scripts\deploy.ps1 -Help
param(
    [string]$Message = "",
    [switch]$NoBuild,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ($Help) {
    Get-Content $PSCommandPath -TotalCount 6 | Select-Object -Skip 1 | ForEach-Object { $_ -replace '^#\s?', '' }
    exit 0
}

$Remote    = if ($env:DEPLOY_REMOTE) { $env:DEPLOY_REMOTE } else { "dev" }
$ServerDir = if ($env:SERVER_DIR)    { $env:SERVER_DIR }    else { "~/FinGate" }
$BuildFlag = if ($NoBuild) { "" } else { "--build" }

function Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Invoke-Git([string[]]$args_) {
    & git @args_
    if ($LASTEXITCODE -ne 0) { throw "git $($args_[0]) that bai (exit $LASTEXITCODE)" }
}

# 0. Ve top-level repo
Invoke-Git @("rev-parse", "--show-toplevel") | ForEach-Object { Set-Location $_ }
$Branch = (git rev-parse --abbrev-ref HEAD).Trim()

# 1. Commit (neu co -Message) va dam bao working tree sach
if ($Message) {
    Step "Commit thay doi: $Message"
    git add -A
    git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) { Invoke-Git @("commit", "-m", $Message) }
    else { Write-Host "Khong co thay doi de commit."; $null = git diff --quiet }
}
git diff --quiet
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Working tree con thay doi chua commit. Dung -Message hoac commit tay roi chay lai."
    git status --short
    exit 1
}

# 2. Push len GitHub
Step "Push $Branch len origin"
$LocalSha  = (git rev-parse HEAD).Trim()
$OriginSha = ((git rev-parse "origin/$Branch" 2>$null) + "").Trim()
if ($LocalSha -eq $OriginSha -and $LocalSha) {
    Write-Host "Da dong bo voi origin, bo qua push."
} else {
    Invoke-Git @("push", "-u", "origin", $Branch)
}
$Short = (git rev-parse --short HEAD).Trim()

# 3. Deploy tren server (gui script bash qua stdin, dung `bash -s`)
Step "Deploy $Short len ${Remote}:$ServerDir"
$remoteScript = @"
set -euo pipefail
cd $ServerDir
echo "[server] Pull $Branch..."
git fetch origin $Branch
git checkout $Branch
git reset --hard origin/$Branch
echo "[server] Build & up..."
docker compose -f deploy/compose.yml --profile onprem up -d $BuildFlag
echo "[server] Trang thai container:"
docker compose ps
echo "[server] Log gan nhat:"
sleep 3
docker compose logs --tail=15 app
"@
# Duong ong PowerShell toi ssh luon them `r -> ghi file tach (LF-only) roi dung cmd redirection de giu nguyen bytes.
$tf = Join-Path ([System.IO.Path]::GetTempPath()) "deploy-remote-$PID.sh"
[System.IO.File]::WriteAllText($tf, ($remoteScript -replace "`r", "") + "`n")
try {
    cmd /c "ssh $Remote `"bash -s`" < `"$tf`""
    if ($LASTEXITCODE) { throw "deploy tren server that bai" }
} finally {
    Remove-Item $tf -Force
}

# 4. Health check qua ssh
Step "Health check"
ssh $Remote "curl -fsS -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:9380/"
if ($LASTEXITCODE) { throw "Health check FAIL" }
Write-Host "Production OK - commit $Short" -ForegroundColor Green
