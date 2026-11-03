Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$root = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Classes\openkraken', $false)
$values = New-Object 'System.Collections.Generic.List[object]'
$keys = New-Object 'System.Collections.Generic.List[string]'
function Read-Key([Microsoft.Win32.RegistryKey]$Key, [string]$Path) {
    $keys.Add($Path)
    foreach ($name in ($Key.GetValueNames() | Sort-Object)) {
        $values.Add(@{
            path = $Path
            name = $name
            kind = $Key.GetValueKind($name).ToString()
            value = $Key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        })
    }
    foreach ($name in ($Key.GetSubKeyNames() | Sort-Object)) {
        $child = $Key.OpenSubKey($name, $false)
        try { Read-Key $child "$Path\$name" } finally { $child.Dispose() }
    }
}
try {
    if ($null -ne $root) { Read-Key $root '' }
    @{ exists = $null -ne $root; keys = @($keys.ToArray()); values = @($values.ToArray()) } | ConvertTo-Json -Depth 8 -Compress
} finally {
    if ($null -ne $root) { $root.Dispose() }
}
