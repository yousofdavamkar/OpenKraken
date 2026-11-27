param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$Fingerprint,
    [switch]$Sign,
    [string]$TimestampUrl,
    [switch]$RequireTimestamp
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Certificate-Fingerprint($Certificate) {
    $hash = [System.Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($Certificate.RawData)).Replace('-', '') }
    finally { $hash.Dispose() }
}

if ($Sign) {
    $matchesByHash = @(Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object {
        $_.HasPrivateKey -and (Certificate-Fingerprint $_) -eq $Fingerprint
    })
    if ($matchesByHash.Count -ne 1) { throw 'Expected one matching current-user code-signing certificate with a private key' }
    $kits = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots').KitsRoot10
    $sdkBins = Get-ChildItem -LiteralPath (Join-Path $kits 'bin') -Directory | Where-Object {
        $_.Name -match '^\d+\.\d+\.\d+\.\d+$'
    } | Sort-Object -Property { [version]$_.Name } -Descending
    $tool = $sdkBins | ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $tool) { throw 'Windows SDK x64 SignTool is required for signing' }
    $arguments = @('sign', '/s', 'My', '/sha1', $matchesByHash[0].Thumbprint, '/fd', 'SHA256')
    if ($TimestampUrl) { $arguments += @('/tr', $TimestampUrl, '/td', 'SHA256') }
    & $tool @arguments $Path
    if ($LASTEXITCODE -ne 0) { throw "SignTool failed with exit code $LASTEXITCODE" }
}

$signature = Get-AuthenticodeSignature -LiteralPath $Path
if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or
    $null -eq $signature.SignerCertificate -or (Certificate-Fingerprint $signature.SignerCertificate) -ne $Fingerprint) {
    throw "Expected a valid embedded Authenticode signature from the selected publisher on $Path"
}
if (($RequireTimestamp -or $TimestampUrl) -and $null -eq $signature.TimeStamperCertificate) {
    throw "Missing Authenticode timestamp on $Path"
}
