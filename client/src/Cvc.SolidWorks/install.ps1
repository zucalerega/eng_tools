# Registers the CVC add-in with SolidWorks 2025. Run from the add-in's folder, as administrator:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$dll = Join-Path $PSScriptRoot 'Cvc.SolidWorks.dll'
if (-not (Test-Path $dll)) { throw "Cvc.SolidWorks.dll isn't next to this script." }

# Files from a downloaded zip are marked as coming from the internet; .NET won't load them that way.
Get-ChildItem -Path $PSScriptRoot -Recurse | Unblock-File

$regasm = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe'
& $regasm /codebase $dll
if ($LASTEXITCODE -ne 0) { throw "RegAsm failed with exit code $LASTEXITCODE" }

# cvc:// links, which the web app's "Open in SolidWorks" uses, go to cvc-open.exe in this folder.
$open = Join-Path $PSScriptRoot 'cvc-open.exe'
$link = 'HKLM:\SOFTWARE\Classes\cvc'
New-Item -Path "$link\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $link -Name '(default)' -Value 'URL:Vault'
Set-ItemProperty -Path $link -Name 'URL Protocol' -Value ''
Set-ItemProperty -Path "$link\shell\open\command" -Name '(default)' -Value "`"$open`" `"%1`""

Write-Host ''
Write-Host 'Vault is registered. Start SolidWorks: the Vault tab is in the task pane on the right.'
Write-Host "Keep this folder where it is: SolidWorks loads the add-in from $PSScriptRoot."
