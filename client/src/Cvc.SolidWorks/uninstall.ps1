# Removes the CVC add-in from SolidWorks. Run from the add-in's folder, as administrator:
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$dll = Join-Path $PSScriptRoot 'Cvc.SolidWorks.dll'
$regasm = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe'
& $regasm /unregister $dll
if ($LASTEXITCODE -ne 0) { throw "RegAsm failed with exit code $LASTEXITCODE" }
Remove-Item -Path 'HKLM:\SOFTWARE\Classes\cvc' -Recurse -Force -ErrorAction SilentlyContinue

Write-Host 'CVC is unregistered. Your workspace (C:\CVC) and saved sign-in are untouched.'
