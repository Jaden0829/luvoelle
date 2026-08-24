param(
  [string]$OutputPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) ("Luvoelle-diagnostics-{0}.zip" -f (Get-Date -Format 'yyyyMMdd-HHmmss')))
)

$ErrorActionPreference = 'SilentlyContinue'
$tempRoot = Join-Path $env:TEMP ("Luvoelle-diagnostics-{0}" -f ([Guid]::NewGuid().ToString('N')))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

$userData = Join-Path $env:APPDATA 'Luvoelle'
$diagnostics = Join-Path $userData 'diagnostics.log'
if (Test-Path -LiteralPath $diagnostics) {
  $allowedTypes = 'startup-|main-|render-process-gone|child-process-gone|ocr-utility-|uncaught|unhandled|recovery-failed'
  Get-Content -LiteralPath $diagnostics -Tail 1200 |
    Where-Object { $_ -match $allowedTypes } |
    Select-Object -Last 300 |
    Set-Content -LiteralPath (Join-Path $tempRoot 'Luvoelle-startup.log') -Encoding UTF8
}

$system = @(
  "CollectedAt=$((Get-Date).ToString('o'))"
  "Windows=$([Environment]::OSVersion.VersionString)"
  "Is64BitOS=$([Environment]::Is64BitOperatingSystem)"
  "Is64BitProcess=$([Environment]::Is64BitProcess)"
  "MemoryGB=$([Math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1))"
  "CPU=$((Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name).Trim())"
)
$installed = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' |
  Where-Object { $_.DisplayName -eq 'Luvoelle' } |
  Select-Object -First 1
if ($installed) {
  $system += "LuvoelleVersion=$($installed.DisplayVersion)"
  $system += "InstallLocation=$($installed.InstallLocation)"
}
$system | Set-Content -LiteralPath (Join-Path $tempRoot 'system.txt') -Encoding UTF8

Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = (Get-Date).AddDays(-7) } |
  Where-Object { $_.Message -match '(?i)Luvoelle\.exe' } |
  Select-Object -First 20 TimeCreated, ProviderName, Id, LevelDisplayName, Message |
  Format-List | Out-File -LiteralPath (Join-Path $tempRoot 'Windows-application-errors.txt') -Encoding UTF8

$crashRoots = @(
  (Join-Path $userData 'Crashpad\reports'),
  (Join-Path $userData 'Crashpad\pending')
)
foreach ($crashRoot in $crashRoots) {
  if (!(Test-Path -LiteralPath $crashRoot)) { continue }
  Get-ChildItem -LiteralPath $crashRoot -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 3 |
    Copy-Item -Destination $tempRoot -Force
}

$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory) { New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null }
Compress-Archive -Path (Join-Path $tempRoot '*') -DestinationPath $OutputPath -Force
Remove-Item -LiteralPath $tempRoot -Recurse -Force
Write-Output $OutputPath
