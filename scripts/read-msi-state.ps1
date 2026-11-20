param(
    [Parameter(Mandatory = $true)][string]$UpgradeCode,
    [Parameter(Mandatory = $true)][string]$ComponentCode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Exists([string]$Path) {
    try { $null = Get-Item -LiteralPath $Path -Force; return $true }
    catch [System.Management.Automation.ItemNotFoundException] { return $false }
}
function Registry-Exists([Microsoft.Win32.RegistryKey]$Hive, [string]$Path) {
    $key = $Hive.OpenSubKey($Path, $false)
    try { return $null -ne $key } finally { if ($null -ne $key) { $key.Dispose() } }
}
$local = [Environment]::GetFolderPath('LocalApplicationData')
$roaming = [Environment]::GetFolderPath('ApplicationData')
$programs = [Environment]::GetFolderPath('Programs')
if (-not $local -or -not $roaming -or -not $programs) { throw 'Native user folders are unavailable' }
$installDirectory = Join-Path $local 'Programs\openkraken'
$profileDirectory = Join-Path $roaming 'OpenKraken'
$shortcutPath = Join-Path $programs 'OpenKraken.lnk'
$installer = New-Object -ComObject WindowsInstaller.Installer
$related = $null
try {
    # Read-only MSI APIs: never query Win32_Product or provide/repair a component.
    $related = $installer.RelatedProducts($UpgradeCode)
    $products = New-Object 'System.Collections.Generic.List[object]'
    for ($index = 0; $index -lt $related.Count; $index++) {
        $code = [string]$related.Item($index)
        $products.Add(@{
            productCode = $code
            state = [int]$installer.ProductState($code)
            version = [string]$installer.ProductInfo($code, 'VersionString')
            componentPath = [string]$installer.ComponentPath($code, $ComponentCode)
        })
    }
    $shortcut = $null
    $shortcutExists = Exists $shortcutPath
    if ($shortcutExists) {
        $target = $installer.ShortcutTarget($shortcutPath)
        try {
            $shortcut = @{
                productCode = [string]$target.StringData(1)
                feature = [string]$target.StringData(2)
                componentCode = [string]$target.StringData(3)
            }
        } finally { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($target) }
    }
    $betaRevisions = @{}
    $betaKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\OpenKraken\Installer\Beta')
    if ($null -ne $betaKey) {
        try {
            foreach ($core in $betaKey.GetSubKeyNames()) {
                $marker = $betaKey.OpenSubKey($core)
                try {
                    $value = $marker.GetValue('Sequence')
                    if ($null -ne $value) { $betaRevisions[$core] = $value }
                } finally { $marker.Dispose() }
            }
        } finally { $betaKey.Dispose() }
    }
    $protocol = (& (Join-Path $PSScriptRoot 'read-windows-protocol.ps1')) | ConvertFrom-Json
    @{
        betaRevisions = $betaRevisions
        products = @($products.ToArray())
        installDirectory = $installDirectory
        profileDirectory = $profileDirectory
        shortcutPath = $shortcutPath
        applicationExists = Exists $installDirectory
        profileExists = Exists $profileDirectory
        shortcutExists = $shortcutExists
        shortcut = $shortcut
        protocol = $protocol
        machineApplicationExists = (Exists (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'openkraken')) -or (Exists (Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'openkraken'))
        machineShortcutExists = Exists (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'OpenKraken.lnk')
        machineProtocolExists = Registry-Exists ([Microsoft.Win32.Registry]::LocalMachine) 'Software\Classes\openkraken'
        userChoiceExists = Registry-Exists ([Microsoft.Win32.Registry]::CurrentUser) 'Software\Microsoft\Windows\Shell\Associations\UrlAssociations\openkraken'
    } | ConvertTo-Json -Depth 12 -Compress
} finally {
    if ($null -ne $related) { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($related) }
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
}
