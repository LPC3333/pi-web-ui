<# 
Pi Web UI - Stop all services
#>

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "       Pi Web UI - Stopping Services" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

$ports = @(3001, 5173)
$found = $false

foreach ($port in $ports) {
    $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    foreach ($conn in $connections) {
        try {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction Stop
            Write-Host "  Stopped port $port (PID: $($conn.OwningProcess))" -ForegroundColor Green
            $found = $true
        } catch {
            Write-Host "  Failed to stop port $port (PID: $($conn.OwningProcess))" -ForegroundColor Red
            $found = $true
        }
    }
}

if (-not $found) {
    Write-Host "  No running Pi Web UI services found." -ForegroundColor Gray
}

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan

Read-Host "Press Enter to exit"
