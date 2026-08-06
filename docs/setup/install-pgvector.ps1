<#
.SYNOPSIS
  Installs the already-compiled pgvector extension into PostgreSQL 18.

.DESCRIPTION
  pgvector was built from source (v0.8.1) against this machine's PostgreSQL 18
  headers using the installed MSVC Build Tools. Only the final copy into
  "C:\Program Files\PostgreSQL\18" requires Administrator rights.

.NOTES
  Run from an ELEVATED PowerShell:
      powershell -ExecutionPolicy Bypass -File docs\setup\install-pgvector.ps1
#>

param(
  [string]$BuildDir = 'C:\Users\Bashar\AppData\Local\Temp\claude\C--GulfUniversity-Library\db368e1e-6387-4b8f-9148-039750426794\scratchpad\pgvector',
  [string]$PgRoot   = 'C:\Program Files\PostgreSQL\18'
)

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Error 'This script must be run from an elevated (Administrator) PowerShell.'
  exit 1
}

if (-not (Test-Path "$BuildDir\vector.dll")) {
  Write-Error "vector.dll not found in $BuildDir. Re-run the build step first."
  exit 1
}
if (-not (Test-Path $PgRoot)) {
  Write-Error "PostgreSQL not found at $PgRoot"
  exit 1
}

Write-Host "Installing pgvector into $PgRoot ..."
Copy-Item "$BuildDir\vector.dll"        "$PgRoot\lib\vector.dll" -Force
Copy-Item "$BuildDir\vector.control"    "$PgRoot\share\extension\" -Force
Copy-Item "$BuildDir\sql\vector--*.sql" "$PgRoot\share\extension\" -Force

Write-Host ''
Write-Host 'Installed files:'
Get-ChildItem "$PgRoot\lib\vector.dll", "$PgRoot\share\extension\vector*" |
  Select-Object Name, Length | Format-Table -AutoSize

Write-Host 'Done. Verify with:'
Write-Host '  psql -U postgres -c "CREATE EXTENSION vector;" -d postgres'
