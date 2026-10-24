# HERMES notification worker: shows one Windows toast and exits.
# Title and body come from HERMES_TOAST_TITLE / HERMES_TOAST_BODY (never parsed as script) and are
# inserted as XML text nodes, so markup in them is displayed, not interpreted.
$ErrorActionPreference = 'Stop'
$title = [string]$env:HERMES_TOAST_TITLE
$body = [string]$env:HERMES_TOAST_BODY
if (-not $title) { exit 2 }

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

# Toasts need a registered AppUserModelID: the installed HERMES shortcut when present, otherwise
# Windows PowerShell's own (always registered), so the notice still appears.
$appId = 'com.hermes.desktop'
$registered = $false
try { $registered = [bool](Get-StartApps | Where-Object { $_.AppID -eq $appId }) } catch { }
if (-not $registered) { $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe' }

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
$texts = $xml.GetElementsByTagName('text')
$texts.Item(0).AppendChild($xml.CreateTextNode($title)) | Out-Null
$texts.Item(1).AppendChild($xml.CreateTextNode($body)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = 'hermes'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
exit 0
