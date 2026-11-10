# Resizes the Loreweaver logo into the PNG sizes scripts/build-icon.mjs
# assembles into build/icon.ico. Uses System.Drawing (no npm deps needed).
# Usage: powershell -File scripts/build-icon.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile((Join-Path $root 'Loreweaver.png'))
$pngDir = Join-Path $root 'build\pngs'
New-Item -ItemType Directory -Force $pngDir | Out-Null

foreach ($size in 256, 128, 64, 48, 32, 24, 16) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.Dispose()
    $out = Join-Path $pngDir "icon_$size.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "wrote $out"
}
$src.Dispose()
