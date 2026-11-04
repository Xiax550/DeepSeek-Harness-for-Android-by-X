[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sdk = $env:ANDROID_HOME
$java = $env:JAVA_HOME
$python = $env:DSH_PYTHON
if (-not $sdk -or -not $java -or -not $python) { throw 'Set ANDROID_HOME, JAVA_HOME and DSH_PYTHON first' }
$destination = Join-Path $root 'build\overlay-instrumentation'
$classes = Join-Path $destination 'classes'
$dex = Join-Path $destination 'dex'
New-Item -ItemType Directory -Force -Path $destination,$classes,$dex | Out-Null
$android = Join-Path $sdk 'platforms\android-35\android.jar'
& (Join-Path $sdk 'build-tools\35.0.0\aapt2.exe') link -I $android --manifest (Join-Path $root 'test-device\AndroidManifest.xml') -o (Join-Path $destination 'base.apk')
if ($LASTEXITCODE -ne 0) { throw 'Test manifest build failed' }
& (Join-Path $java 'bin\javac.exe') -encoding UTF-8 -source 8 -target 8 -classpath $android -d $classes (Join-Path $root 'test-device\OverlayInstrumentation.java') (Join-Path $root 'test-device\OverlayTestActivity.java')
if ($LASTEXITCODE -ne 0) { throw 'Test Java compile failed' }
$classFiles = @(Get-ChildItem $classes -Filter '*.class' -Recurse | ForEach-Object FullName)
& (Join-Path $java 'bin\java.exe') -cp (Join-Path $sdk 'build-tools\35.0.0\lib\d8.jar') com.android.tools.r8.D8 --release --min-api 26 --lib $android --output $dex @classFiles
if ($LASTEXITCODE -ne 0) { throw 'Test dex build failed' }
& $python (Join-Path $root 'scripts\pack_apk.py') (Join-Path $destination 'base.apk') (Join-Path $destination 'unsigned.apk') "classes.dex:$(Join-Path $dex 'classes.dex')"
if ($LASTEXITCODE -ne 0) { throw 'Test APK assembly failed' }
$keystore = Join-Path $root 'keystore\dha.p12'
if (-not (Test-Path -LiteralPath $keystore)) { throw 'Production certificate required for signed instrumentation' }
$ksPass = if ($env:KS_PASS) { $env:KS_PASS } else { 'dha-local' }
$ksAlias = if ($env:KS_ALIAS) { $env:KS_ALIAS } else { 'dha' }
& (Join-Path $sdk 'build-tools\35.0.0\apksigner.bat') sign --ks $keystore --ks-pass "pass:$ksPass" --ks-key-alias $ksAlias --out (Join-Path $destination 'DHA-overlay-test.apk') (Join-Path $destination 'unsigned.apk')
if ($LASTEXITCODE -ne 0) { throw 'Test APK signing failed' }
& (Join-Path $sdk 'build-tools\35.0.0\apksigner.bat') verify (Join-Path $destination 'DHA-overlay-test.apk')
if ($LASTEXITCODE -ne 0) { throw 'Test APK signature verification failed' }
Write-Host "Test APK ready: $destination\DHA-overlay-test.apk"
