$ErrorActionPreference = 'Stop'
$viewerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$viewerUrl = 'http://127.0.0.1:8768'
$viewerPython = 'C:\Program Files\Python313\python.exe'
if (-not (Test-Path -LiteralPath $viewerPython)) {
    $viewerPython = (Get-Command python -ErrorAction Stop).Source
}
$viewerReady = $false
try {
    $viewerHealth = Invoke-RestMethod -Uri "$viewerUrl/api/health" -TimeoutSec 2
    $viewerReady = $viewerHealth.ok -and $viewerHealth.offline
} catch {}
if (-not $viewerReady) {
    $viewerScript = Join-Path $viewerRoot 'server.py'
    Start-Process -FilePath $viewerPython -ArgumentList @('-B', '-u', "`"$viewerScript`"") -WorkingDirectory $viewerRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $viewerRoot 'server.log') -RedirectStandardError (Join-Path $viewerRoot 'server-errors.log')
    for ($viewerAttempt = 0; $viewerAttempt -lt 40; $viewerAttempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $viewerHealth = Invoke-RestMethod -Uri "$viewerUrl/api/health" -TimeoutSec 2
            if ($viewerHealth.ok) { $viewerReady = $true; break }
        } catch {}
    }
}
if (-not $viewerReady) { throw "The viewer could not start. Check server-errors.log in $viewerRoot." }
# Open the viewer as an app window (no tabs or address bar) in Edge or Chrome, which run it offline like any page;
# the default browser otherwise. The graph's own window (its button in the chart toolbar) opens the same way.
$appBrowser = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if ($appBrowser) {
    Start-Process -FilePath $appBrowser -ArgumentList @("--app=$viewerUrl", '--window-size=1600,1000')
} else {
    Start-Process $viewerUrl
}
