# Registers the Vault add-in with SolidWorks 2025. Run from the add-in's folder, as administrator:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$dll = Join-Path $PSScriptRoot 'Vault.SolidWorks.dll'
if (-not (Test-Path $dll)) { throw "Vault.SolidWorks.dll isn't next to this script." }

# Files from a downloaded zip are marked as coming from the internet; .NET won't load them that way.
Get-ChildItem -Path $PSScriptRoot -Recurse | Unblock-File

$regasm = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe'

# The add-in from before 0.4.0, when it was CVC's, if it's still in this folder: unregistered and deleted, as setup does.
$old = Join-Path $PSScriptRoot 'Cvc.SolidWorks.dll'
if (Test-Path $old) {
    & $regasm /unregister $old
    if ($LASTEXITCODE -ne 0) { throw "RegAsm failed with exit code $LASTEXITCODE" }
    'Cvc.SolidWorks.dll', 'Cvc.Client.dll', 'cvc-open.exe', 'cvc-open.exe.config' |
        ForEach-Object { Remove-Item -Path (Join-Path $PSScriptRoot $_) -Force -ErrorAction SilentlyContinue }
}

& $regasm /codebase $dll
if ($LASTEXITCODE -ne 0) { throw "RegAsm failed with exit code $LASTEXITCODE" }

# vault:// links, which the web app's "Open in SolidWorks" uses, go to vault-open.exe in this folder; so do cvc://
# ones, which the web app makes until every laptop has this version (docs/design.md, "Names from before YJSP").
$open = Join-Path $PSScriptRoot 'vault-open.exe'
foreach ($link in 'HKLM:\SOFTWARE\Classes\vault', 'HKLM:\SOFTWARE\Classes\cvc') {
    New-Item -Path "$link\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path $link -Name '(default)' -Value 'URL:Vault'
    Set-ItemProperty -Path $link -Name 'URL Protocol' -Value ''
    Set-ItemProperty -Path "$link\shell\open\command" -Name '(default)' -Value "`"$open`" `"%1`""
}

Write-Host ''
Write-Host 'Vault is registered. Start SolidWorks: the Vault tab is in the task pane on the right.'
Write-Host "Keep this folder where it is: SolidWorks loads the add-in from $PSScriptRoot."
