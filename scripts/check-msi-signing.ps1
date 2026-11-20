Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# This test briefly trusts a unique, short-lived fixture certificate on a hosted VM.
node --input-type=module -e "import { assertDisposableWindows } from './scripts/msi-lifecycle.mjs'; assertDisposableWindows();"
if ($LASTEXITCODE -ne 0) { throw 'MSI signing fixture requires disposable Windows opt-in' }

$certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject ("CN=OpenKraken CI " + [guid]::NewGuid()) -CertStoreLocation Cert:\CurrentUser\My -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddDays(1)
$public = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (,$certificate.RawData)
$roots = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
$trusted = $false
try {
    $roots.Open('ReadWrite')
    $roots.Add($public)
    $trusted = $true
    $hash = [System.Security.Cryptography.SHA256]::Create()
    try { $pin = [BitConverter]::ToString($hash.ComputeHash($public.RawData)).Replace('-', '') }
    finally { $hash.Dispose() }
    $root = (Get-Location).Path
    $fixture = New-Item -ItemType Directory -Path (Join-Path $root ('release/msi-signing-' + [guid]::NewGuid()))
    Copy-Item -LiteralPath 'package.json' -Destination $fixture.FullName
    Copy-Item -LiteralPath 'build-resources' -Destination $fixture.FullName -Recurse
    $null = New-Item -ItemType Junction -Path (Join-Path $fixture.FullName 'node_modules') -Target (Join-Path $root 'node_modules')
    Push-Location $fixture.FullName
    try {
        node "$root/scripts/package.mjs" --win-identity $pin
        if ($LASTEXITCODE -ne 0) { throw 'Signed Windows bundle build failed' }
        node "$root/scripts/installers.mjs" --test-metadata --target msi --win-identity $pin
        if ($LASTEXITCODE -ne 0) { throw 'Signed MSI build failed' }
    } finally { Pop-Location }
    $receipt = Join-Path $fixture.FullName 'release/installers/win32-x64/test-signed/msi/manifest.json'
    node scripts/verify-installer.mjs $receipt --win-identity $pin
    if ($LASTEXITCODE -ne 0) { throw 'Signed MSI verification failed' }

    $manifest = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
    $file = Join-Path (Split-Path $receipt) $manifest.artifact.file
    function Assert-Rejected([string]$Path, [string]$Fingerprint, [string]$Expected, [switch]$Timestamp) {
        try { & "$PSScriptRoot/windows-authenticode.ps1" -Path $Path -Fingerprint $Fingerprint -RequireTimestamp:$Timestamp }
        catch {
            if ($_.Exception.Message.Contains($Expected)) { return }
            throw
        }
        throw "Expected Authenticode rejection: $Expected"
    }
    Assert-Rejected $file ('AB' * 32) 'selected publisher'
    Assert-Rejected $file $pin 'Missing Authenticode timestamp' -Timestamp
    $changed = Join-Path $fixture.FullName 'modified-helper.exe'
    $helper = Join-Path $fixture.FullName 'release/OpenKraken-win32-x64/resources/app.asar.unpacked/dist/helpers/openkraken-askpass.exe'
    Copy-Item -LiteralPath $helper -Destination $changed
    $stream = [IO.File]::Open($changed, 'Open', 'ReadWrite', 'None')
    try {
        $stream.Position = 4096
        $byte = $stream.ReadByte()
        if ($byte -lt 0) { throw 'Expected bundled PE helper fixture' }
        $stream.Position = 4096
        $stream.WriteByte($byte -bxor 1)
    } finally { $stream.Dispose() }
    Assert-Rejected $changed $pin 'selected publisher'
    $unsigned = Get-Content -LiteralPath 'release/installers/win32-x64/test/msi/manifest.json' -Raw | ConvertFrom-Json
    Assert-Rejected (Join-Path 'release/installers/win32-x64/test/msi' $unsigned.artifact.file) $pin 'selected publisher'
} finally {
    try { if ($trusted) { $roots.Remove($public) } }
    finally {
        $roots.Close()
        $public.Dispose()
        Remove-Item -LiteralPath ('Cert:\CurrentUser\My\' + $certificate.Thumbprint) -DeleteKey
    }
}
