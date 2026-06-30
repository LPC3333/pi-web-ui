<# 
Pi Web UI - One-click launcher
Double-click start.bat to run this script.
#>

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Resolve-Path $ScriptDir).Path

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "       Pi Web UI - One-Click Launcher" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

# ============================================================
# Step 1: Check Node.js
# ============================================================
Write-Host "[1/5] Checking Node.js..." -ForegroundColor Yellow

try {
    $null = Get-Command node -ErrorAction Stop
    $version = & node -v
    Write-Host "       Node.js found: $version" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Node.js not found. Please install Node.js first:" -ForegroundColor Red
    Write-Host "        https://nodejs.org/" -ForegroundColor White
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host ""

# ============================================================
# Step 2: Check and install dependencies
# ============================================================
Write-Host "[2/5] Checking dependencies..." -ForegroundColor Yellow

$needInstall = $false

if (-not (Test-Path "$ProjectRoot\node_modules")) {
    Write-Host "       Root node_modules missing" -ForegroundColor DarkYellow
    $needInstall = $true
}
if (-not (Test-Path "$ProjectRoot\client\node_modules")) {
    Write-Host "       client\node_modules missing" -ForegroundColor DarkYellow
    $needInstall = $true
}

if ($needInstall) {
    Write-Host ""
    Write-Host "       Installing dependencies, please wait..." -ForegroundColor White
    Write-Host ""

    Write-Host "       [1/2] Installing root dependencies..." -ForegroundColor Yellow
    Push-Location $ProjectRoot
    $result = & npm install 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Root dependency install failed:" -ForegroundColor Red
        Write-Host $result
        Pop-Location
        Read-Host "Press Enter to exit"
        exit 1
    }

    Write-Host "       [2/2] Installing client dependencies..." -ForegroundColor Yellow
    Set-Location "$ProjectRoot\client"
    $result = & npm install 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Client dependency install failed:" -ForegroundColor Red
        Write-Host $result
        Pop-Location
        Read-Host "Press Enter to exit"
        exit 1
    }
    Pop-Location

    Write-Host ""
    Write-Host "       Dependencies installed!" -ForegroundColor Green
} else {
    Write-Host "       Dependencies ready" -ForegroundColor Green
}
Write-Host ""

# ============================================================
# Step 3: Kill old processes
# ============================================================
Write-Host "[3/5] Cleaning up old processes..." -ForegroundColor Yellow

$ports = @(3001, 5173)
$found = $false
foreach ($port in $ports) {
    $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    foreach ($conn in $connections) {
        try {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction Stop
            Write-Host "       Stopped port $port (PID: $($conn.OwningProcess))" -ForegroundColor Green
            $found = $true
        } catch {
            Write-Host "       Could not stop port $port (PID: $($conn.OwningProcess))" -ForegroundColor DarkYellow
        }
    }
}
if (-not $found) {
    Write-Host "       No old processes found" -ForegroundColor Gray
}
Start-Sleep -Seconds 2
Write-Host ""

# ============================================================
# Step 4: Start services
# ============================================================
Write-Host "[4/5] Starting services..." -ForegroundColor Yellow

$LogDir = "$env:TEMP\pi-web-ui"
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# Start backend - use cmd /c because npx is a .cmd script, not an .exe
$serverArgs = '/c', 'npx', 'tsx', 'server/index.ts', '>>', "$LogDir\server.log", '2>&1'
$serverProc = Start-Process -FilePath "cmd.exe" `
    -ArgumentList $serverArgs `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Minimized `
    -PassThru
Write-Host "       Backend started (port 3001, PID: $($serverProc.Id))" -ForegroundColor Green

# Start frontend
$clientArgs = '/c', 'npx', 'vite', '--host', '>>', "$LogDir\vite.log", '2>&1'
$clientProc = Start-Process -FilePath "cmd.exe" `
    -ArgumentList $clientArgs `
    -WorkingDirectory "$ProjectRoot\client" `
    -WindowStyle Minimized `
    -PassThru
Write-Host "       Frontend started (port 5173, PID: $($clientProc.Id))" -ForegroundColor Green

Write-Host ""

# ============================================================
# Step 5: Wait for server and open browser
# ============================================================
Write-Host "[5/5] Waiting for server to be ready..." -ForegroundColor Yellow

$maxTries = 30
$ready = $false
for ($i = 0; $i -lt $maxTries; $i++) {
    try {
        # Use a raw TCP connection test instead of Invoke-WebRequest (which throws on connection refused)
        $tcp = New-Object System.Net.Sockets.TcpClient
        $connect = $tcp.BeginConnect("127.0.0.1", 3001, $null, $null)
        $wait = $connect.AsyncWaitHandle.WaitOne(2000, $false)
        if ($wait) {
            $tcp.EndConnect($connect)
            $tcp.Close()
            $ready = $true
            break
        }
        $tcp.Close()
    } catch {
        # Port not listening yet
    }
    Start-Sleep -Seconds 1
}

if ($ready) {
    Write-Host "       Server is ready!" -ForegroundColor Green
} else {
    Write-Host "       Warning: Server startup timed out after 30s" -ForegroundColor DarkYellow
    Write-Host "       Check logs at $LogDir" -ForegroundColor DarkYellow
}

# Open browser regardless (frontend may show connection error but at least user sees the page)
Start-Process "http://localhost:5173"

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "       Pi Web UI is running!" -ForegroundColor Green
Write-Host "       Frontend: http://localhost:5173" -ForegroundColor White
Write-Host "       Backend:  http://localhost:3001" -ForegroundColor White
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Logs: $LogDir" -ForegroundColor Gray
Write-Host "  Tip: Run stop.bat to stop all services." -ForegroundColor Gray
Write-Host ""

Read-Host "Press Enter to close this window"
