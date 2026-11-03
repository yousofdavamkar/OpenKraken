param([Parameter(Mandatory = $true)][string]$Directory)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$root = Get-Item -LiteralPath $Directory -Force
if (-not $root.PSIsContainer) { throw 'Expected a Windows application directory' }
$prefix = $root.FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$pending = New-Object 'System.Collections.Generic.Stack[System.IO.FileSystemInfo]'
$entries = New-Object 'System.Collections.Generic.List[object]'
$pending.Push($root)
while ($pending.Count -gt 0) {
    $item = $pending.Pop()
    # Check before enumerating children: do not traverse junctions or other
    # reparse points, including ones that Node does not report as symlinks.
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Windows payload contains a reparse point: $($item.FullName)"
    }
    $key = if ($item.FullName -eq $root.FullName) { '' } else { $item.FullName.Substring($prefix.Length).Replace('\', '/') }
    $acl = Get-Acl -LiteralPath $item.FullName
    $descriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(), 0)
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
        @{
            sid = $_.IdentityReference.Value
            type = $_.AccessControlType.ToString().ToLowerInvariant()
            rights = [int]$_.FileSystemRights
            inheritOnly = ($_.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
        }
    })
    $entries.Add(@{
        path = $key
        type = if ($item -is [System.IO.DirectoryInfo]) { 'directory' } else { 'file' }
        owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
        daclPresent = $null -ne $descriptor.DiscretionaryAcl
        rules = $rules
    })
    if ($item -is [System.IO.DirectoryInfo]) {
        foreach ($child in (Get-ChildItem -LiteralPath $item.FullName -Force)) {
            $pending.Push($child)
        }
    }
}
@{ currentUserSid = $currentUserSid; entries = @($entries.ToArray()) } | ConvertTo-Json -Depth 8 -Compress
