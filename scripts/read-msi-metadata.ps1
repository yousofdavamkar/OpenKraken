param([Parameter(Mandatory = $true)][string]$Artifact)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $null
$summary = $null
try {
    # 0 is read-only. Never use Win32_Product, which can repair other products.
    $database = $installer.OpenDatabase($Artifact, 0)
    function Read-Rows([string]$Query, [string[]]$Columns) {
        $view = $database.OpenView($Query)
        try {
            $view.Execute()
            while ($null -ne ($record = $view.Fetch())) {
                try {
                    $row = @{}
                    for ($index = 0; $index -lt $Columns.Length; $index++) {
                        $row[$Columns[$index]] = [string]$record.StringData($index + 1)
                    }
                    $row
                } finally { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
            }
        } finally {
            $view.Close()
            [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
        }
    }
    $properties = @{}
    foreach ($row in (Read-Rows 'SELECT `Property`, `Value` FROM `Property`' @('name', 'value'))) {
        $properties[$row.name] = $row.value
    }
    $tables = @(Read-Rows 'SELECT `Name` FROM `_Tables`' @('name') | ForEach-Object { $_.name })
    $customActions = if ($tables -contains 'CustomAction') {
        @(Read-Rows 'SELECT `Action` FROM `CustomAction`' @('id'))
    } else { @() }
    $removedRegistry = if ($tables -contains 'RemoveRegistry') {
        @(Read-Rows 'SELECT `RemoveRegistry` FROM `RemoveRegistry`' @('id'))
    } else { @() }
    $summary = $database.SummaryInformation(0)
    @{
        properties = $properties
        summary = @{ template = [string]$summary.Property(7); wordCount = [int]$summary.Property(15) }
        customActions = @($customActions)
        removedRegistry = @($removedRegistry)
        conditions = @(Read-Rows 'SELECT `Condition` FROM `LaunchCondition`' @('condition'))
        registry = @(Read-Rows 'SELECT `Registry`, `Root`, `Key`, `Name`, `Value`, `Component_` FROM `Registry`' @('id', 'root', 'key', 'name', 'value', 'component'))
        components = @(Read-Rows 'SELECT `Component`, `Attributes`, `KeyPath` FROM `Component`' @('id', 'attributes', 'keyPath'))
        files = @(Read-Rows 'SELECT `File`, `FileName`, `Component_` FROM `File`' @('id', 'name', 'component'))
        shortcuts = @(Read-Rows 'SELECT `Shortcut`, `Directory_`, `Name`, `Component_`, `Target`, `Arguments`, `WkDir` FROM `Shortcut`' @('id', 'directory', 'name', 'component', 'target', 'arguments', 'workingDirectory'))
    } | ConvertTo-Json -Depth 8 -Compress
} finally {
    if ($null -ne $summary) { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($summary) }
    if ($null -ne $database) { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) }
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
}
