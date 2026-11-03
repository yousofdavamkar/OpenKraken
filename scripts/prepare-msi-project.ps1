param([Parameter(Mandatory = $true)][string]$Project)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$settings = New-Object System.Xml.XmlReaderSettings
$settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
$settings.XmlResolver = $null
$reader = [System.Xml.XmlReader]::Create($Project, $settings)
$document = New-Object System.Xml.XmlDocument
$document.XmlResolver = $null
try { $document.Load($reader) } finally { $reader.Dispose() }
$namespace = 'http://wixtoolset.org/schemas/v4/wxs'
if ($document.DocumentElement.LocalName -ne 'Wix' -or $document.DocumentElement.NamespaceURI -ne $namespace) {
    throw 'Unexpected MSI project schema; review the pinned builder before upgrading'
}
$names = New-Object System.Xml.XmlNamespaceManager($document.NameTable)
$names.AddNamespace('w', $namespace)
$product = $document.SelectSingleNode('/w:Wix/w:Product', $names)
$package = $document.SelectSingleNode('/w:Wix/w:Product/w:Package', $names)
$group = $document.SelectSingleNode('//w:ComponentGroup[@Id="ProductComponents"]', $names)
$executable = $document.SelectSingleNode('//w:File[@Id="mainExecutable"]', $names)
$allUsers = $document.SelectSingleNode('//w:Property[@Id="ALLUSERS"]', $names)
$perUser = $document.SelectSingleNode('//w:Property[@Id="MSIINSTALLPERUSER"]', $names)
if ($null -eq $product -or $null -eq $package -or $null -eq $group -or
    $null -eq $executable -or $executable.GetAttribute('Name') -ne 'openkraken.exe' -or
    $null -eq $allUsers -or $allUsers.GetAttribute('Value') -ne '2' -or
    $null -eq $perUser -or $perUser.GetAttribute('Value') -ne '1' -or
    $document.SelectNodes('//w:CustomAction | //w:Component[@Id="OpenKrakenProtocol"]', $names).Count -ne 0) {
    throw 'Unexpected MSI project: require per-user defaults, the application executable and no custom actions'
}

$package.SetAttribute('InstallPrivileges', 'limited')
$condition = $document.CreateElement('Condition', $namespace)
$condition.SetAttribute('Message', 'OpenKraken installs for the current user only.')
$condition.InnerText = 'NOT ALLUSERS OR (ALLUSERS = "2" AND MSIINSTALLPERUSER = "1")'
[void]$product.AppendChild($condition)

# This component owns only its four registry values. Windows Installer handles
# upgrade/removal; never recursively delete the user's Classes registry tree.
$component = $document.CreateElement('Component', $namespace)
$component.SetAttribute('Id', 'OpenKrakenProtocol')
$component.SetAttribute('Guid', '*')
$component.SetAttribute('Win64', 'yes')
$values = @(
    @{ Id = 'OpenKrakenProtocolName'; Key = 'Software\Classes\openkraken'; Value = 'URL:OpenKraken repository'; KeyPath = 'yes' },
    @{ Id = 'OpenKrakenProtocolMarker'; Key = 'Software\Classes\openkraken'; Name = 'URL Protocol'; Value = '' },
    @{ Id = 'OpenKrakenProtocolIcon'; Key = 'Software\Classes\openkraken\DefaultIcon'; Value = '"[#mainExecutable]",0' },
    @{ Id = 'OpenKrakenProtocolCommand'; Key = 'Software\Classes\openkraken\shell\open\command'; Value = '"[#mainExecutable]" "%1"' }
)
foreach ($attributes in $values) {
    $value = $document.CreateElement('RegistryValue', $namespace)
    $value.SetAttribute('Root', 'HKCU')
    $value.SetAttribute('Type', 'string')
    foreach ($name in $attributes.Keys) { $value.SetAttribute($name, $attributes[$name]) }
    [void]$component.AppendChild($value)
}
[void]$group.AppendChild($component)
$document.Save($Project)
