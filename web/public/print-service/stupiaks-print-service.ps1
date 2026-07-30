param(
  [int]$Port = 8788
)

$ErrorActionPreference = 'Stop'
$ServiceVersion = 'stupiaks-windows-print-service-v24'
$TrustedOrigins = @(
  'https://stupiaks-ops.sporkburger19.workers.dev',
  'http://localhost:5173',
  'http://localhost:5188'
)

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class StupiaksRawPrinterV24 {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern int StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr hPrinter, byte[] bytes, int count, out int written);
  public static int Send(string printer, byte[] bytes) {
    IntPtr handle;
    if (!OpenPrinter(printer, out handle, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter failed");
    try {
      var doc = new DOCINFOA { pDocName = "Stupiak Label", pDataType = "RAW", pOutputFile = null };
      if (StartDocPrinter(handle, 1, doc) == 0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartDocPrinter failed");
      try {
        if (!StartPagePrinter(handle)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartPagePrinter failed");
        try {
          int written;
          if (!WritePrinter(handle, bytes, bytes.Length, out written) || written != bytes.Length) throw new IOException("Windows spooler did not accept the complete RAW label job");
          return written;
        } finally { EndPagePrinter(handle); }
      } finally { EndDocPrinter(handle); }
    } finally { ClosePrinter(handle); }
  }
}
'@

function Clean([object]$Value) {
  if ($null -eq $Value) { return '' }
  return ([string]$Value).Trim()
}

function Get-PrinterRows {
  if (Get-Command Get-Printer -ErrorAction SilentlyContinue) {
    return @(Get-Printer | ForEach-Object {
      [pscustomobject]@{
        name = Clean $_.Name
        driver = Clean $_.DriverName
        port = Clean $_.PortName
        status = Clean $_.PrinterStatus
        offline = [bool]$_.WorkOffline
        shared = [bool]$_.Shared
        platform = 'windows'
      }
    } | Where-Object { $_.name })
  }

  return @(Get-CimInstance Win32_Printer | ForEach-Object {
    [pscustomobject]@{
      name = Clean $_.Name
      driver = Clean $_.DriverName
      port = Clean $_.PortName
      status = Clean $_.PrinterStatus
      offline = [bool]$_.WorkOffline
      shared = [bool]$_.Shared
      platform = 'windows'
    }
  } | Where-Object { $_.name })
}

function Find-Printer([string]$Name) {
  $SafeName = Clean $Name
  if (-not $SafeName) { throw 'Installed Windows printer name is required.' }
  $Printer = Get-PrinterRows | Where-Object { $_.name -ieq $SafeName } | Select-Object -First 1
  if (-not $Printer) { throw "Windows printer '$SafeName' was not found on this computer." }
  if ($Printer.offline) { throw "Windows printer '$($Printer.name)' is offline." }
  return $Printer
}

function Test-RawTcp([string]$HostName, [int]$TargetPort = 9100, [int]$TimeoutMs = 3000) {
  $HostName = Clean $HostName
  if (-not $HostName) { throw 'Printer IP address is required.' }
  $Client = New-Object System.Net.Sockets.TcpClient
  try {
    $Async = $Client.BeginConnect($HostName, $TargetPort, $null, $null)
    if (-not $Async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { throw "Connection to $HostName`:$TargetPort timed out." }
    $Client.EndConnect($Async)
    return $true
  } finally {
    $Client.Close()
  }
}

function Send-RawTcp([byte[]]$Bytes, [string]$HostName, [int]$TargetPort = 9100, [int]$TimeoutMs = 7000) {
  $HostName = Clean $HostName
  if (-not $HostName) { throw 'Printer IP address is required.' }
  $Client = New-Object System.Net.Sockets.TcpClient
  try {
    $Async = $Client.BeginConnect($HostName, $TargetPort, $null, $null)
    if (-not $Async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { throw "Raw TCP print to $HostName`:$TargetPort timed out." }
    $Client.EndConnect($Async)
    $Client.SendTimeout = $TimeoutMs
    $Stream = $Client.GetStream()
    try {
      $Stream.Write($Bytes, 0, $Bytes.Length)
      $Stream.Flush()
    } finally {
      $Stream.Dispose()
    }
    return [pscustomobject]@{
      printer = "$HostName`:$TargetPort"
      bytes = $Bytes.Length
      accepted = $true
      printed = $false
      physical_verified = $false
      status = 'raw_tcp_data_sent'
    }
  } finally {
    $Client.Close()
  }
}

function Get-StatusText([int]$Status) {
  switch ($Status) {
    200 { 'OK' }
    204 { 'No Content' }
    400 { 'Bad Request' }
    403 { 'Forbidden' }
    404 { 'Not Found' }
    413 { 'Payload Too Large' }
    500 { 'Internal Server Error' }
    default { 'OK' }
  }
}

function Write-HttpResponse($Stream, [int]$Status, $Payload, [string]$Origin = '') {
  $Body = if ($Status -eq 204) { '' } else { $Payload | ConvertTo-Json -Compress -Depth 8 }
  $BodyBytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
  $AllowedOrigin = if ($TrustedOrigins -contains $Origin) { $Origin } else { '' }
  $Headers = @(
    "HTTP/1.1 $Status $(Get-StatusText $Status)",
    'Content-Type: application/json; charset=utf-8',
    "Content-Length: $($BodyBytes.Length)",
    'Cache-Control: no-store',
    'Access-Control-Allow-Headers: Content-Type',
    'Access-Control-Allow-Methods: GET, POST, OPTIONS',
    'Access-Control-Allow-Private-Network: true',
    'Access-Control-Max-Age: 86400',
    'Vary: Origin',
    'Connection: close'
  )
  if ($AllowedOrigin) { $Headers += "Access-Control-Allow-Origin: $AllowedOrigin" }
  $HeaderBytes = [System.Text.Encoding]::ASCII.GetBytes(($Headers -join "`r`n") + "`r`n`r`n")
  $Stream.Write($HeaderBytes, 0, $HeaderBytes.Length)
  if ($BodyBytes.Length -gt 0) { $Stream.Write($BodyBytes, 0, $BodyBytes.Length) }
  $Stream.Flush()
}

function Read-HttpRequest($Stream) {
  $Reader = New-Object System.IO.StreamReader($Stream, [System.Text.Encoding]::UTF8, $false, 4096, $true)
  $RequestLine = $Reader.ReadLine()
  if (-not $RequestLine) { return $null }
  $Parts = $RequestLine.Split(' ')
  if ($Parts.Count -lt 2) { throw 'Invalid HTTP request line.' }
  $Headers = @{}
  while ($true) {
    $Line = $Reader.ReadLine()
    if ($null -eq $Line -or $Line -eq '') { break }
    $Index = $Line.IndexOf(':')
    if ($Index -gt 0) {
      $Headers[$Line.Substring(0, $Index).Trim().ToLowerInvariant()] = $Line.Substring($Index + 1).Trim()
    }
  }
  $Length = 0
  if ($Headers.ContainsKey('content-length')) { [void][int]::TryParse($Headers['content-length'], [ref]$Length) }
  if ($Length -gt 12582912) { throw 'Print payload is too large.' }
  $Body = ''
  if ($Length -gt 0) {
    $Buffer = New-Object char[] $Length
    $Offset = 0
    while ($Offset -lt $Length) {
      $Read = $Reader.Read($Buffer, $Offset, $Length - $Offset)
      if ($Read -le 0) { break }
      $Offset += $Read
    }
    if ($Offset -gt 0) { $Body = -join $Buffer[0..($Offset - 1)] }
  }
  return [pscustomobject]@{
    method = $Parts[0].ToUpperInvariant()
    path = ($Parts[1] -split '\?')[0]
    headers = $Headers
    origin = Clean ($Headers['origin'])
    body = $Body
  }
}

function Parse-Body($Request) {
  if (-not (Clean $Request.body)) { return [pscustomobject]@{} }
  return $Request.body | ConvertFrom-Json
}

$Listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
$Listener.Start()
Write-Host "Stupiak's Windows Print Service $ServiceVersion running on http://127.0.0.1:$Port"

try {
  while ($true) {
    $Client = $Listener.AcceptTcpClient()
    $Stream = $null
    $Request = $null
    try {
      $Client.ReceiveTimeout = 15000
      $Client.SendTimeout = 15000
      $Stream = $Client.GetStream()
      $Request = Read-HttpRequest $Stream
      if ($null -eq $Request) { continue }

      if ($Request.method -eq 'OPTIONS') {
        if (-not ($TrustedOrigins -contains $Request.origin)) {
          Write-HttpResponse $Stream 403 @{ ok = $false; error = 'This website is not allowed to use the Local Print Service.' } $Request.origin
        } else {
          Write-HttpResponse $Stream 204 @{} $Request.origin
        }
        continue
      }

      if (-not ($TrustedOrigins -contains $Request.origin)) {
        Write-HttpResponse $Stream 403 @{ ok = $false; error = 'This website is not allowed to use the Local Print Service.' } $Request.origin
        continue
      }

      if ($Request.method -eq 'GET' -and $Request.path -eq '/health') {
        Write-HttpResponse $Stream 200 @{
          ok = $true
          service = $ServiceVersion
          platform = 'windows'
          automatic = $true
          pairing_token_required = $false
          capabilities = @('queue', 'raw_tcp')
        } $Request.origin
        continue
      }

      if ($Request.method -eq 'GET' -and $Request.path -eq '/printers') {
        Write-HttpResponse $Stream 200 @{ ok = $true; printers = @(Get-PrinterRows); platform = 'windows' } $Request.origin
        continue
      }

      if ($Request.method -eq 'POST' -and $Request.path -eq '/test') {
        $Body = Parse-Body $Request
        $Mode = (Clean $Body.mode).ToLowerInvariant()
        if ($Mode -eq 'queue') {
          $Printer = Find-Printer (Clean $Body.queue)
          Write-HttpResponse $Stream 200 @{ ok = $true; connected = $true; mode = 'queue'; printer = $Printer.name; queue = $Printer } $Request.origin
        } else {
          $TargetPort = if ($Body.port) { [int]$Body.port } else { 9100 }
          [void](Test-RawTcp (Clean $Body.host) $TargetPort 3000)
          Write-HttpResponse $Stream 200 @{ ok = $true; connected = $true; mode = 'raw_tcp'; printer = "$(Clean $Body.host)`:$TargetPort" } $Request.origin
        }
        continue
      }

      if ($Request.method -eq 'POST' -and $Request.path -eq '/print') {
        $Body = Parse-Body $Request
        $Payload = Clean $Body.payloadBase64
        if (-not $Payload) { throw 'Print request is missing payloadBase64.' }
        $Bytes = [Convert]::FromBase64String($Payload)
        if ($Bytes.Length -eq 0) { throw 'Print payload is empty.' }
        $Mode = (Clean $Body.mode).ToLowerInvariant()
        if ($Mode -eq 'queue') {
          $Printer = Find-Printer (Clean $Body.queue)
          $Written = [StupiaksRawPrinterV24]::Send($Printer.name, $Bytes)
          Write-HttpResponse $Stream 200 @{
            ok = $true
            accepted = $true
            printed = $false
            physical_verified = $false
            status = 'queue_accepted'
            printer = $Printer.name
            bytes = $Written
            queue = $Printer
          } $Request.origin
        } else {
          $TargetPort = if ($Body.port) { [int]$Body.port } else { 9100 }
          $TimeoutMs = if ($Body.timeoutMs) { [int]$Body.timeoutMs } else { 7000 }
          $Result = Send-RawTcp $Bytes (Clean $Body.host) $TargetPort $TimeoutMs
          Write-HttpResponse $Stream 200 @{ ok = $true; accepted = $Result.accepted; printed = $Result.printed; physical_verified = $Result.physical_verified; status = $Result.status; printer = $Result.printer; bytes = $Result.bytes } $Request.origin
        }
        continue
      }

      Write-HttpResponse $Stream 404 @{ ok = $false; error = 'Local Print Service endpoint was not found.' } $Request.origin
    } catch {
      try { Write-HttpResponse $Stream 500 @{ ok = $false; error = Clean $_.Exception.Message } $Request.origin } catch {}
    } finally {
      if ($Stream) { $Stream.Dispose() }
      $Client.Close()
    }
  }
} finally {
  $Listener.Stop()
}
