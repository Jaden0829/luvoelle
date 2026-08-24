$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LuvoelleDpiAwareness {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
try { [void][LuvoelleDpiAwareness]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Write-WorkerMessage($message) {
    [Console]::Out.WriteLine(($message | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
}

function Read-AutomationTargets($handles) {
    $targets = New-Object System.Collections.Generic.List[object]
    $roots = New-Object System.Collections.Generic.List[object]
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    $maximumElements = 700

    foreach ($handleValue in @($handles)) {
        if ($targets.Count -ge $maximumElements) { break }
        try {
            $handle = [IntPtr]([Int64]::Parse([string]$handleValue, [Globalization.CultureInfo]::InvariantCulture))
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
            if ($null -eq $root) { continue }
            $rootRect = $root.Current.BoundingRectangle
            $roots.Add([pscustomobject]@{
                handle = [string]$handleValue
                left = [Math]::Round($rootRect.Left, 2)
                top = [Math]::Round($rootRect.Top, 2)
                right = [Math]::Round($rootRect.Right, 2)
                bottom = [Math]::Round($rootRect.Bottom, 2)
            })
            $rootArea = [Math]::Max(1.0, $rootRect.Width * $rootRect.Height)
            $elements = $root.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Automation]::ControlViewCondition
            )
            $count = [Math]::Min($elements.Count, $maximumElements - $targets.Count)
            for ($index = 0; $index -lt $count; $index += 1) {
                try {
                    $element = $elements.Item($index)
                    $current = $element.Current
                    if ($current.IsOffscreen) { continue }
                    $rect = $current.BoundingRectangle
                    if ($rect.IsEmpty -or $rect.Width -lt 24 -or $rect.Height -lt 14) { continue }
                    if (($rect.Width * $rect.Height) -ge ($rootArea * 0.985)) { continue }
                    $left = [Math]::Round($rect.Left, 2)
                    $top = [Math]::Round($rect.Top, 2)
                    $right = [Math]::Round($rect.Right, 2)
                    $bottom = [Math]::Round($rect.Bottom, 2)
                    $key = "$left,$top,$right,$bottom"
                    if (-not $seen.Add($key)) { continue }
                    $controlType = [string]$current.ControlType.ProgrammaticName
                    if ($controlType.StartsWith('ControlType.')) { $controlType = $controlType.Substring(12) }
                    $name = ([string]$current.Name).Trim()
                    if ([string]::IsNullOrWhiteSpace($name)) { $name = $controlType }
                    if ([string]::IsNullOrWhiteSpace($name)) { $name = 'Smart region' }
                    if ($name.Length -gt 72) { $name = $name.Substring(0, 72) + '...' }
                    $targets.Add([pscustomobject]@{
                        left = $left
                        top = $top
                        right = $right
                        bottom = $bottom
                        title = $name
                        controlType = $controlType
                        zIndex = $index
                    })
                } catch {
                    # Some providers invalidate individual elements while the tree is read.
                }
            }
        } catch {
            # A window without a working UI Automation provider is simply skipped.
        }
    }
    return [pscustomobject]@{ targets = $targets.ToArray(); roots = $roots.ToArray() }
}

Write-WorkerMessage @{ type = 'ready' }
while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
        $request = $line | ConvertFrom-Json
        if ($request.type -eq 'shutdown') { break }
        if ($request.type -eq 'scan') {
            $started = [Environment]::TickCount
            $scan = Read-AutomationTargets $request.handles
            $elapsed = [Environment]::TickCount - $started
            if ($elapsed -lt 0) { $elapsed += [Int32]::MaxValue }
            Write-WorkerMessage @{ type = 'result'; id = $request.id; targets = @($scan.targets); roots = @($scan.roots); elapsedMs = $elapsed }
        }
    } catch {
        $requestId = if ($null -ne $request) { $request.id } else { $null }
        Write-WorkerMessage @{ type = 'error'; id = $requestId; message = ($_.Exception.Message + ' ' + $_.InvocationInfo.PositionMessage) }
    }
}
