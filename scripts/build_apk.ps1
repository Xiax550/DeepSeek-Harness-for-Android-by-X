<#
.SYNOPSIS
  Build the DHA APK on Windows without Gradle.

.DESCRIPTION
  Port of upstream's scripts/build_apk.sh to PowerShell. Upstream runs this in a Linux
  sandbox with aapt2 under qemu; on Windows we drive the Android SDK's native aapt2.exe,
  javac, d8.jar and apksigner.jar directly.

  Pipeline: make_icons -> stage payload -> aapt2 compile -> aapt2 link -> generate
  BuildInfo.java -> javac -> d8 -> pack_apk.py (alignment) -> apksigner.

.PARAMETER Slim
  Build the slim shell with no rootfs payload (~2 MB). Useful to validate the toolchain
  before spending time on the 330 MB payload pack.

.PARAMETER SkipIcons
  Reuse the already-generated mipmaps instead of regenerating them.

.EXAMPLE
  pwsh -File scripts\build_apk.ps1 -Slim
  pwsh -File scripts\build_apk.ps1
#>
[CmdletBinding()]
param(
    [switch]$Slim,
    [switch]$SkipIcons,
    [string]$PayloadZip,
    [string]$PayloadManifest,
    [string]$HotZip,
    [string]$ProotSo,
    [string]$AppVersion,
    [int]$AppCode
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---------------------------------------------------------------- paths
# Resolve the project root robustly: the script normally lives in <root>/scripts, but it
# may also be dot-sourced from a scriptblock (Windows PowerShell execution policy), where
# $PSScriptRoot is unset. Fall back to walking up from the current directory.
$Root = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { $null }
if (-not $Root -or -not (Test-Path (Join-Path $Root 'app\AndroidManifest.xml'))) {
    $probe = (Get-Location).Path
    while ($probe -and -not (Test-Path (Join-Path $probe 'app\AndroidManifest.xml'))) {
        $parent = Split-Path -Parent $probe
        if ($parent -eq $probe) { $probe = $null; break }
        $probe = $parent
    }
    if (-not $probe) { throw 'cannot locate project root (no app\AndroidManifest.xml above the current directory)' }
    $Root = $probe
}
$App = Join-Path $Root 'app'
$Build = Join-Path $Root 'build'
$Out = Join-Path $Root 'out'

$Sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $null }
$JavaHome = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { $null }
$Python = if ($env:DSH_PYTHON) { $env:DSH_PYTHON } else {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand) { $pythonCommand.Source } else { $null }
}

$Aapt2    = Join-Path $Sdk 'build-tools\35.0.0\aapt2.exe'
$D8Jar    = Join-Path $Sdk 'build-tools\35.0.0\lib\d8.jar'
$ApkSigner= Join-Path $Sdk 'build-tools\35.0.0\apksigner.bat'
$AndroidJar = Join-Path $Sdk 'platforms\android-35\android.jar'
$Javac    = Join-Path $JavaHome 'bin\javac.exe'
$Java     = Join-Path $JavaHome 'bin\java.exe'
$Keytool  = Join-Path $JavaHome 'bin\keytool.exe'

$Keystore = Join-Path $Root 'keystore\dha.p12'
$KsPass   = if ($env:KS_PASS) { $env:KS_PASS } else { 'dha-local' }
$KsAlias  = if ($env:KS_ALIAS) { $env:KS_ALIAS } else { 'dha' }

# Default payload locations: assets extracted from an official dsh-android APK.
$RefRoot = if ($env:DSH_REF) { $env:DSH_REF } else { Join-Path $Root 'external-assets' }
if (-not $PayloadZip)      { $PayloadZip      = Join-Path $RefRoot 'official-assets\payload.zip' }
if (-not $PayloadManifest) { $PayloadManifest = Join-Path $RefRoot 'official-assets\payload.manifest' }
if (-not $HotZip)          { $HotZip          = Join-Path $RefRoot 'official-assets\hot.zip' }
if (-not $ProotSo)         { $ProotSo         = Join-Path $RefRoot 'official-assets\libproot.so' }
$VoiceModel  = Join-Path $App 'assets\vosk-model-small-cn.zip'
$VoiceNative = Join-Path $App 'libs\arm64-v8a'

if (-not $AppVersion) { $AppVersion = (Get-Content (Join-Path $Root 'VERSION') -Raw).Trim() }
if (-not $AppCode) {
    $codeFile = Join-Path $Root 'VERSION_CODE'
    if (Test-Path $codeFile) {
        $AppCode = [int](Get-Content $codeFile -Raw).Trim()
    } else {
        $parts = $AppVersion.Split('.')
        $AppCode = [int]$parts[0] * 10000 + [int]$parts[1] * 100 + [int]$parts[2]
    }
}

$APK_NAME = if ($Slim) { 'DHA-slim.apk' } else { 'DHA.apk' }

# ---------------------------------------------------------------- preflight
function Assert-File([string]$Path, [string]$What) {
    if (-not (Test-Path -LiteralPath $Path)) { throw "missing $What`: $Path" }
}

if (-not $Sdk) { throw 'ANDROID_HOME is not set; point it at an Android SDK installation' }
if (-not $JavaHome) { throw 'JAVA_HOME is not set; point it at a JDK installation' }
if (-not $Python) { throw 'DSH_PYTHON is not set and no python executable was found on PATH' }

function ConvertTo-ArgString {
    <#
      Quote one argument for a Windows command line.

      ProcessStartInfo.ArgumentList is .NET Core-only and this runs on Windows
      PowerShell 5.1 (.NET Framework 4.x), so the only way to preserve argument
      boundaries is to build the quoted command line ourselves.
    #>
    param([string]$Value)
    if ($Value -eq '') { return '""' }
    if ($Value -notmatch '[ \t"]') { return $Value }
    # Backslashes are only special immediately before a closing quote.
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

<#
  Run a native tool and decide success from its EXIT CODE only.

  Three Windows PowerShell traps this avoids:
    1. Anything a native process writes to stderr becomes a NativeCommandError, which
       under $ErrorActionPreference='Stop' aborts the script. javac and aapt2 write
       benign progress/warnings there.
    2. PowerShell resolves a native tool's OWN flags at the CALL SITE, against this
       function's parameters -- aapt2's `-o` matched `-OutVariable` and killed the
       build before the function body ran. So the native arguments are passed as a
       single -NativeArgs array, never as loose tokens.
    3. Argument quoting for paths containing spaces is handled by ProcessStartInfo's
       ArgumentList rather than PowerShell's re-quoting.
#>
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][string[]]$NativeArgs,
        [string]$What = ''
    )
    $name = if ($What) { $What } else { Split-Path -Leaf $Exe }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $quoted = $NativeArgs | ForEach-Object { ConvertTo-ArgString ([string]$_) }
    $psi.Arguments = ($quoted -join ' ')
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    $code = $proc.ExitCode
    if ($stdout) { $stdout -split "`r?`n" | Where-Object { $_ -ne '' } | ForEach-Object { Write-Host "   $_" } }
    if ($stderr) { $stderr -split "`r?`n" | Where-Object { $_ -ne '' } | ForEach-Object { Write-Host "   $_" -ForegroundColor DarkYellow } }
    if ($code -ne 0) { throw "$name failed (exit $code)" }
}
foreach ($pair in @(
    @($Aapt2, 'aapt2'), @($D8Jar, 'd8.jar'), @($AndroidJar, 'android.jar'),
    @($Javac, 'javac'), @($Java, 'java'), @($Python, 'python'),
    @($ApkSigner, 'apksigner')
)) { Assert-File $pair[0] $pair[1] }

New-Item -ItemType Directory -Force -Path $Build, $Out,
    (Join-Path $Build 'dex'), (Join-Path $Build 'classes'),
    (Join-Path $Build 'res-flat'), (Join-Path $Build 'payload-assets'),
    (Join-Path $Build 'hot-assets') | Out-Null

Write-Host "== 0/8 icons ==" -ForegroundColor Cyan
if (-not $SkipIcons) {
    $officialRes = Join-Path $RefRoot 'official-res'
    $iconSource = Join-Path $Root 'assets\dha-icon-source.png'
    if (Test-Path $iconSource) {
        Invoke-Native -Exe $Python -NativeArgs @(
            (Join-Path $Root 'scripts\make_icons.py'), $officialRes,
            (Join-Path $App 'res'), (Join-Path $App 'res')
        ) -What 'make_icons.py'
    } else {
        throw "missing project icon source: $iconSource"
    }
} else {
    Write-Host '   skipped (-SkipIcons)'
}

Write-Host "== 1/8 payload staging ==" -ForegroundColor Cyan
$assets = @()
if (-not $Slim) {
    Assert-File $PayloadZip 'payload.zip'
    Assert-File $PayloadManifest 'payload.manifest'
    Assert-File $ProotSo 'libproot.so'
    Copy-Item $PayloadZip (Join-Path $Build 'payload-assets\payload.zip') -Force
    Copy-Item $PayloadManifest (Join-Path $Build 'payload-assets\payload.manifest') -Force
    $pz = Join-Path $Build 'payload-assets\payload.zip'
    Write-Host ("   payload.zip {0} MB" -f [math]::Round((Get-Item $pz).Length / 1MB, 2))
    $assets += "assets/payload.zip:$pz"
    $assets += "assets/payload.manifest:$(Join-Path $Build 'payload-assets\payload.manifest')"
    Assert-File $ProotSo 'libproot.so'
} else {
    Write-Host '   slim: 不带 rootfs 载荷'
    # The app still needs something to exec; slim builds carry the proot binary only.
    Assert-File $ProotSo 'libproot.so'
}
Assert-File $HotZip 'hot.zip'
Assert-File $VoiceModel 'vosk-model-small-cn.zip'
Assert-File (Join-Path $VoiceNative 'libvosk.so') 'libvosk.so'
Assert-File (Join-Path $VoiceNative 'libjnidispatch.so') 'libjnidispatch.so'
# Always regenerate the hot overlay from THIS tree before packing.
#
# The default $HotZip points at a hot.zip extracted from the official APK, and the
# upstream packer's `--base` mode stamps every rebuild with `sp0`. Both together meant a
# changed hot payload produced an identical version string, and the app's "already
# applied" check (version equality, see HotVersion.shouldReplay) then skipped it -- the
# change shipped nothing, which is exactly what happened to the xdg-user-dir shim.
# scripts/make_hot_zip_windows.py derives `sp` from the package content instead, so a
# content change always produces a new version string.
$hotGenerated = Join-Path $Build 'hot-generated.zip'
Invoke-Native -Exe $Python -NativeArgs @(
    (Join-Path $Root 'scripts\make_hot_zip_windows.py'), $Root, $hotGenerated, '--check'
) -What 'make_hot_zip_windows.py'
Copy-Item $hotGenerated (Join-Path $Build 'hot-assets\hot.zip') -Force
$assets += "assets/hot.zip:$(Join-Path $Build 'hot-assets\hot.zip')"
$assets += "assets/vosk-model-small-cn.zip:$VoiceModel"
foreach ($legalName in @('LICENSE', 'NOTICE.md', 'THIRD_PARTY.md', 'OPEN_SOURCE_COMPLIANCE.md')) {
    $legalPath = Join-Path $Root $legalName
    Assert-File $legalPath $legalName
    $assets += "assets/licenses/$legalName`:$legalPath"
}
foreach ($license in Get-ChildItem (Join-Path $Root 'LICENSES') -File -Filter *.txt) {
    $assets += "assets/licenses/$($license.Name)`:$($license.FullName)"
}

Write-Host "== 2/8 compile resources ==" -ForegroundColor Cyan
$resFlat = Join-Path $Build 'res-flat\res.zip'
Remove-Item $resFlat -Force -ErrorAction SilentlyContinue
Invoke-Native -Exe $Aapt2 -NativeArgs @(
    'compile', '--dir', (Join-Path $App 'res'), '-o', $resFlat
) -What 'aapt2 compile'

Write-Host "== 3/8 link ==" -ForegroundColor Cyan
$buildR = Join-Path $Build 'r'
Remove-Item $buildR -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $buildR | Out-Null
$baseApk = Join-Path $Build 'base.apk'
Invoke-Native -Exe $Aapt2 -NativeArgs @(
    'link',
    '-I', $AndroidJar,
    '--manifest', (Join-Path $App 'AndroidManifest.xml'),
    '--min-sdk-version', '26', '--target-sdk-version', '28',
    '--version-code', "$AppCode", '--version-name', $AppVersion,
    '--java', $buildR,
    '-o', $baseApk, $resFlat
) -What 'aapt2 link'

Write-Host "== 4/8 BuildInfo ==" -ForegroundColor Cyan
# The payload version is a content hash: reusing upstream's payload keeps it identical,
# which matters because the app unpacks by that version.
$payloadHash = if ($Slim) { 'slim' } else {
    (Get-FileHash (Join-Path $Build 'payload-assets\payload.zip') -Algorithm SHA256).Hash.ToLower().Substring(0, 16)
}
$rootfsVersion = (Get-Content (Join-Path $Root 'ROOTFS_VERSION') -Raw).Trim()
$buildInfoPath = Join-Path $App 'java\com\dha\harness\BuildInfo.java'
$buildInfo = @"
package com.dha.harness;

/** Generated by scripts/build_apk.ps1 — payload content hash. Do not edit. */
final class BuildInfo {
    static final String PAYLOAD_VERSION = "$payloadHash";
    static final String APP_VERSION = "$AppVersion";
    static final int APP_VERSION_CODE = $AppCode;
    static final String ROOTFS_VERSION = "$rootfsVersion";
}
"@
# No BOM: javac treats a leading BOM as an invalid flag.
[System.IO.File]::WriteAllText($buildInfoPath, $buildInfo, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "   app $AppVersion ($AppCode), rootfs t$rootfsVersion, payload $payloadHash"

Write-Host "== 5/8 javac ==" -ForegroundColor Cyan
$classes = Join-Path $Build 'classes'
Remove-Item $classes -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $classes | Out-Null
$srcJava = Join-Path $App 'java'
$sources = Get-ChildItem $srcJava -Recurse -File -Filter *.java | ForEach-Object { $_.FullName }
$sources += Get-ChildItem $buildR -Recurse -File -Filter *.java -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
$libJars = Get-ChildItem (Join-Path $App 'libs') -File -Filter *.jar | ForEach-Object { $_.FullName }
$compileJars = Get-ChildItem (Join-Path $App 'compile-libs') -File -Filter *.jar -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
$classpath = (@($AndroidJar) + $libJars + $compileJars) -join ';'
$sourcesFile = Join-Path $Build 'sources.txt'
# javac rejects a UTF-8 BOM in an @argfile, so write it without one.
[System.IO.File]::WriteAllLines($sourcesFile, $sources, (New-Object System.Text.UTF8Encoding($false)))
Invoke-Native -Exe $Javac -NativeArgs @(
    '-encoding', 'UTF-8', '-nowarn', '-classpath', $classpath, '-d', $classes, "@$sourcesFile"
) -What 'javac'
Write-Host "   compiled $($sources.Count) sources"

Write-Host "== 6/8 d8 ==" -ForegroundColor Cyan
$dexDir = Join-Path $Build 'dex'
Remove-Item $dexDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dexDir | Out-Null
$classFiles = Get-ChildItem $classes -Recurse -File -Filter *.class | ForEach-Object { $_.FullName }
$d8Args = @('-cp', $D8Jar, 'com.android.tools.r8.D8', '--release', '--min-api', '26',
            '--lib', $AndroidJar, '--output', $dexDir) + $classFiles + $libJars
# Command line length: pass class files through an argument file.
$d8ArgFile = Join-Path $Build 'd8args.txt'
$d8Lines = $d8Args | ForEach-Object { '"' + ($_ -replace '\\', '\\') + '"' }
[System.IO.File]::WriteAllLines($d8ArgFile, $d8Lines, (New-Object System.Text.UTF8Encoding($false)))
Invoke-Native -Exe $Java -NativeArgs @("@$d8ArgFile") -What 'd8'

Write-Host "== 7/8 pack ==" -ForegroundColor Cyan
$unsigned = Join-Path $Build 'unsigned.apk'
$packArgs = @(
    (Join-Path $Root 'scripts\pack_apk.py'),
    $baseApk, $unsigned,
    "classes.dex:$(Join-Path $dexDir 'classes.dex')",
    "lib/arm64-v8a/libproot.so:$ProotSo",
    "lib/arm64-v8a/libvosk.so:$(Join-Path $VoiceNative 'libvosk.so')",
    "lib/arm64-v8a/libjnidispatch.so:$(Join-Path $VoiceNative 'libjnidispatch.so')"
) + $assets
Invoke-Native -Exe $Python -NativeArgs $packArgs -What 'pack_apk.py'

Write-Host "== 8/8 sign ==" -ForegroundColor Cyan
if (-not (Test-Path $Keystore)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Keystore) | Out-Null
    Invoke-Native -Exe $Keytool -NativeArgs @(
        '-genkeypair', '-keystore', $Keystore, '-storetype', 'PKCS12',
        '-storepass', $KsPass, '-keypass', $KsPass, '-alias', $KsAlias,
        '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
        '-dname', 'CN=DHA, OU=DHA, O=DHA, L=Unknown, ST=Unknown, C=CN'
    ) -What 'keytool'
    Write-Host "   generated $Keystore"
}
$final = Join-Path $Out $APK_NAME
Remove-Item $final -Force -ErrorAction SilentlyContinue
Invoke-Native -Exe $ApkSigner -NativeArgs @(
    'sign', '--ks', $Keystore, '--ks-pass', "pass:$KsPass", '--key-pass', "pass:$KsPass",
    '--ks-key-alias', $KsAlias, '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true',
    '--out', $final, $unsigned
) -What 'apksigner sign'

Write-Host ''
Write-Host '=== signature ===' -ForegroundColor Cyan
Invoke-Native -Exe $ApkSigner -NativeArgs @('verify', '--print-certs', $final) -What 'apksigner verify'
Write-Host ''
Write-Host ("BUILD OK  {0}  ({1} MB)" -f $final, [math]::Round((Get-Item $final).Length / 1MB, 2)) -ForegroundColor Green
