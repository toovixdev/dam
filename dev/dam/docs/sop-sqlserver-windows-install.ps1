<#
    SecurEra DAM — Windows SQL Server host agent installer.
    Run from an ELEVATED PowerShell on the SQL Server host. Writes the config file, installs the
    Windows service, and starts it. Requires the XEvents session (Step 1) and login (Step 2) to
    already exist — see sop-sqlserver-windows-host-agent.md.

    Example:
      .\sop-sqlserver-windows-install.ps1 `
         -ControlPlane https://dam.yourcompany.com `
         -EnrollToken  tvxenr_xxxxxxxx `
         -Database     YourDB `
         -DbPassword   'CHANGE_ME_strong'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $ControlPlane,
  [Parameter(Mandatory)] [string] $EnrollToken,
  [Parameter(Mandatory)] [string] $Database,
  [Parameter(Mandatory)] [string] $DbPassword,
  [string] $DbUser      = 'dam_svc',
  [string] $TargetHost  = $env:COMPUTERNAME,   # instance identity in DAM (+ local connect target)
  [int]    $TargetPort  = 1433,
  [string] $XeSession   = 'ToovixXE',
  [string] $ExePath     = "$PSScriptRoot\dam-agent.exe",
  [switch] $EnableVa,                          # also run VA scanning
  [switch] $EnableClassify                     # also run column classification
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
      ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  throw 'Run this from an elevated (Administrator) PowerShell.'
}
if (-not (Test-Path $ExePath)) { throw "dam-agent.exe not found at $ExePath" }

# 1. Install the binary to a stable location
$installDir = 'C:\Program Files\SecurEra'
New-Item -ItemType Directory -Force $installDir | Out-Null
$exe = Join-Path $installDir 'dam-agent.exe'
Copy-Item $ExePath $exe -Force

# 2. Write the config file the service reads (C:\ProgramData\SecurEra\dam-agent.env)
$cfgDir = 'C:\ProgramData\SecurEra'
New-Item -ItemType Directory -Force $cfgDir | Out-Null
$lines = @(
  "CONTROL_PLANE=$ControlPlane"
  "AGENT_ENROLL_TOKEN=$EnrollToken"
  "MODE=audit-forward"
  "DB_ENGINE=mssql"
  "AUDIT_SOURCE=xevents"
  "MSSQL_XE_SESSION=$XeSession"
  "TARGET_HOST=$TargetHost"
  "TARGET_PORT=$TargetPort"
  "DB_NAME=$Database"
  "DB_USER=$DbUser"
  "DB_PASSWORD=$DbPassword"
)
if ($EnableClassify) { $lines += 'CLASSIFY=true' }
if ($EnableVa)       { $lines += 'VA_SCAN=true' }
$cfg = Join-Path $cfgDir 'dam-agent.env'
Set-Content -Path $cfg -Value $lines -Encoding ASCII
# lock the config down (it holds a DB password): SYSTEM + Administrators only
icacls $cfg /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' | Out-Null
Write-Host "wrote config -> $cfg"

# 3. Install + start the service
& $exe install
& $exe start
Start-Sleep -Seconds 3
Get-Service TooVixDAMAgent | Format-Table -AutoSize

Write-Host ""
Write-Host "Tail the agent log with:"
Write-Host "  Get-Content 'C:\ProgramData\SecurEra\dam-agent.log' -Tail 20 -Wait"
