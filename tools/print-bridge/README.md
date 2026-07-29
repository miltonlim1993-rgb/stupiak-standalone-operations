# Stupiak's Print Bridge v12

Use the Print Bridge only when a phone or tablet must print through a printer already installed on a Windows or macOS computer.

The bridge does not replace Android direct printing. It adds these computer-assisted routes:

- Windows installed printer queue
- macOS/Linux CUPS printer queue
- Raw TCP from the computer to a printer
- LPR from the computer to a printer
- Local network printer discovery

## Windows

Requirements:

- Windows 10 or Windows 11
- Node.js 22 or newer
- The target printer already installed and able to print from Windows
- The computer and phone/tablet on the same private network

From PowerShell in the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-print-bridge-windows.ps1
```

The installer:

1. Copies the bridge into `%LOCALAPPDATA%\StupiaksPrintBridge`.
2. Starts it automatically at Windows login.
3. Adds a Private-network firewall rule for TCP 8787 when permission allows.
4. Prints the Bridge URL and pairing token.

In Stupiak's Ops:

1. Open **Label Printer Settings**.
2. Choose **PC/Mac Bridge**.
3. Enter the Bridge URL and pairing token shown by the installer.
4. Choose **Installed Queue**.
5. Press **Load queues** and select the Windows printer.
6. Press **Test connection**, then **Test label**.
7. Save and choose **Use on this device**.

Remove the startup task:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-print-bridge-windows.ps1 -Remove
```

## macOS

Requirements:

- Node.js 22 or newer
- The target printer already installed in macOS and able to print
- The Mac and phone/tablet on the same network

From Terminal in the project folder:

```bash
bash scripts/install-print-bridge-macos.sh
```

The installer creates a LaunchAgent, starts the bridge, and shows the Bridge URL and pairing token. Configure **PC/Mac Bridge → Installed Queue** in Stupiak's Ops in the same way as Windows.

## Direct Android routes

Do not install the bridge for these routes:

- **Direct Wi-Fi/LAN:** the printer itself exposes Raw TCP or LPR. Enter the printer's own IP, not the computer IP.
- **Bluetooth Classic:** pair the printer in Android Settings first, then configure its name or MAC address.
- **System / Driver:** use Android System Print, a vendor print service, USB driver, WSD-compatible service, or BLE/vendor driver.

## Service endpoints

- `GET /health`
- `GET /printers`
- `GET /discover?port=9100`
- `POST /test`
- `POST /print`

All endpoints except `/health` require the pairing token. The service binds to port 8787 by default. Override it with `PRINT_BRIDGE_PORT`.

## Safety

The bridge listens only on the local computer/network and requires a random pairing token. Keep the computer on while a phone or tablet uses its printer queue. Do not expose port 8787 to the public internet.
