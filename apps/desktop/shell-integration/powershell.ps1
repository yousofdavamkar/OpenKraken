# pwsh loads the ordinary profiles before this script. Keep both the profile
# prompt and PSReadLine's own history, key handling and command acceptance.
if ($PSVersionTable.PSVersion.Major -lt 7 -or
    $ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage' -or
    (Test-Path Variable:global:__OpenKrakenPowerShell)) { return }

$promptFunction = Get-Item Function:prompt -ErrorAction SilentlyContinue
$readerFunction = Get-Item Function:PSConsoleHostReadLine -ErrorAction SilentlyContinue
if (-not $promptFunction -or -not $readerFunction -or
    $readerFunction.ModuleName -ne 'PSReadLine' -or
    ($promptFunction.Options -band 'ReadOnly,Constant') -or
    ($readerFunction.Options -band 'ReadOnly,Constant')) { return }

$global:__OpenKrakenPowerShell = @{
    Prompt = $promptFunction.ScriptBlock
    Reader = $readerFunction.ScriptBlock
    Running = $false
}
function global:PSConsoleHostReadLine {
    # PSReadLine reads $? on entry. Call it before executing other statements.
    $line = & $global:__OpenKrakenPowerShell.Reader
    if (-not [string]::IsNullOrWhiteSpace($line)) {
        $global:__OpenKrakenPowerShell.Running = $true
        [Console]::Write("`e]133;C`a")
    }
    return $line
}
function global:prompt {
    # Bind the previous outcome as arguments so the user's prompt still sees
    # its original $? on entry, even if the prompt itself runs another program.
    & {
        param($succeeded, $nativeCode)
        $text = & $global:__OpenKrakenPowerShell.Prompt
        $markers = ''
        if ($global:__OpenKrakenPowerShell.Running) {
            $global:__OpenKrakenPowerShell.Running = $false
            $code = 0
            if (-not $succeeded) {
                $history = Microsoft.PowerShell.Core\Get-History -Count 1
                $latest = if ($Error.Count) { $Error[0] }
                $cmdletError = $history -and $latest -and $latest.InvocationInfo -and
                    $latest.InvocationInfo.HistoryId -eq $history.Id -and
                    $latest.FullyQualifiedErrorId -ne 'ProgramExitedWithNonZeroCode'
                $code = if ($cmdletError -or $nativeCode -isnot [int] -or $nativeCode -eq 0) { 1 } else { $nativeCode }
            }
            $markers = "`e]133;D;$code`a"
        }
        return "$markers`e]133;A`a$text`e]133;B`a"
    } $? ($ExecutionContext.SessionState.PSVariable.GetValue('global:LASTEXITCODE'))
}
