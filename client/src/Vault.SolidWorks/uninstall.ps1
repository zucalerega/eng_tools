# Removes the Vault add-in from SolidWorks. Run from the add-in's folder, as administrator:
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$dll = Join-Path $PSScriptRoot 'Vault.SolidWorks.dll'
$regasm = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe'
& $regasm /unregister $dll
if ($LASTEXITCODE -ne 0) { throw "RegAsm failed with exit code $LASTEXITCODE" }
foreach ($link in 'HKLM:\SOFTWARE\Classes\vault', 'HKLM:\SOFTWARE\Classes\cvc') {
    Remove-Item -Path $link -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'Vault is unregistered. Your workspace folder (C:\VLT unless you chose another) and saved sign-in are untouched.'
