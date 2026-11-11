<#
.SYNOPSIS
  安装 / 卸载 dsh-session-delete-menu —— 给 DeepSeek Harness 会话右键菜单加「删除对话」。

.DESCRIPTION
  做三件事：把插件复制到 plugins 和 node_modules；在 profile package.json 的
  dependencies 与 dsh.profile.bundles 里登记；可选重启 DSH 让配置生效。
  每一步都先备份 package.json。

.PARAMETER ProfileName
  DSH profile 名，默认 desktop（对应 %USERPROFILE%\.dsh\profiles\desktop）。

.PARAMETER Restart
  处理完成后重启 DSH（结束 DeepSeek Harness 进程并重新拉起）。

.PARAMETER Uninstall
  卸载插件：撤销登记并删除两份目录。

.PARAMETER Check
  只打印当前安装状态，不修改任何文件。

.EXAMPLE
  pwsh -File .\install.ps1 -Restart

.EXAMPLE
  pwsh -File .\install.ps1 -Uninstall -Restart

.EXAMPLE
  pwsh -File .\install.ps1 -Check
#>
[CmdletBinding()]
param(
    [string]$ProfileName = "desktop",
    [switch]$Restart,
    [switch]$Uninstall,
    [switch]$Check,
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }),
    [string]$DshExe = ""
)

$ErrorActionPreference = "Stop"

$pkg         = "dsh-session-delete-menu"
$profileDir  = Join-Path $DshHome "profiles\$ProfileName"
$pkgFile     = Join-Path $profileDir "package.json"
$srcDir      = $PSScriptRoot
$pluginDir   = Join-Path $profileDir "plugins\$pkg"
$nmDir       = Join-Path $profileDir "node_modules\$pkg"
$cordisYml   = Join-Path $profileDir "cordis.yml"

function New-Backup([string]$path, [string]$suffix) {
    if (Test-Path -LiteralPath $path) {
        Copy-Item -LiteralPath $path -Destination ($path + $suffix) -Force
    }
}

function Invoke-RestartDsh {
    $exe = $null
    $proc = Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc -and $proc.Path) { $exe = $proc.Path }
    if (-not $exe -and $DshExe -and (Test-Path -LiteralPath $DshExe)) { $exe = $DshExe }
    if (-not $exe) {
        Write-Warning "找不到 DeepSeek Harness.exe，请手动重启 DSH。"
        return
    }
    Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 4
    Start-Process $exe
    Write-Host "已重启 DSH：$exe"
}

if (-not (Test-Path -LiteralPath $pkgFile)) {
    throw "找不到 profile 配置：$pkgFile —— 确认 DSH 已安装且 profile 名正确（可用 -ProfileName 指定）。"
}

$raw = [IO.File]::ReadAllText($pkgFile)

# ---------- 只检查 ----------
if ($Check) {
    Write-Host "profile      : $profileDir"
    Write-Host "plugins 目录 : $(Test-Path -LiteralPath $pluginDir)"
    Write-Host "node_modules : $(Test-Path -LiteralPath $nmDir)"
    Write-Host "package.json : 已登记依赖=$($raw -match [regex]::Escape('"' + $pkg + '":'))"
    $bundlePattern = '"bundles"\s*:\s*\[[^\]]*"' + [regex]::Escape($pkg) + '"'
    Write-Host "package.json : 已列入 bundles=$($raw -match $bundlePattern)"
    if (Test-Path -LiteralPath $cordisYml) {
        $hit = Select-String -LiteralPath $cordisYml -Pattern ("id: " + $pkg) -SimpleMatch
        Write-Host "cordis 名册  : $(if ($hit) { '已注册（已生效）' } else { '未注册（改完配置要重启 DSH 才会写入）' })"
    }
    return
}

if ($Uninstall) {
    # ---------- 卸载 ----------
    New-Backup $pkgFile ".bak-sdm"
    $raw = [regex]::Replace($raw, ('(?m)^\s*"' + [regex]::Escape($pkg) + '",?\r?\n'), '')
    $raw = [regex]::Replace($raw, ('(?m)^\s*"' + [regex]::Escape($pkg) + '":.*\r?\n'), '')
    # 删掉最后一项后可能留下 ", ]"，修成合法 JSON
    $raw = [regex]::Replace($raw, ',\s*\]', ']')
    [IO.File]::WriteAllText($pkgFile, $raw)

    foreach ($dir in @($pluginDir, $nmDir)) {
        if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    }
    Write-Host "已卸载 $pkg"
    if ($Restart) { Invoke-RestartDsh }
    return
}

# ---------- 安装 ----------
Write-Host "安装 $pkg 到 profile: $profileDir"

$srcFull = [IO.Path]::GetFullPath($srcDir).TrimEnd('\')
foreach ($target in @($pluginDir, $nmDir)) {
    if ([IO.Path]::GetFullPath($target).TrimEnd('\') -eq $srcFull) {
        Write-Verbose "跳过自复制：$target"
        continue
    }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    foreach ($item in @("lib", "package.json", "cordis.patch.yml", "README.md")) {
        $from = Join-Path $srcDir $item
        if (Test-Path -LiteralPath $from) {
            Copy-Item -LiteralPath $from -Destination $target -Recurse -Force
        }
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $pluginDir "cordis.patch.yml"))) {
    throw "插件缺少 cordis.patch.yml，无法按 bundle 方式注册。请确认解压完整。"
}

New-Backup $pkgFile ".bak-sdm"

$depKey = '"' + $pkg + '":'
if ($raw -notmatch [regex]::Escape($depKey)) {
    $depLine = '    "' + $pkg + '": "file:' + ($pluginDir -replace '\\', '/') + '",'
    $depRe = [regex]'("dependencies"\s*:\s*\{)'
    $raw = $depRe.Replace($raw, ('$1' + "`r`n" + $depLine), 1)
    Write-Host "  + dependencies 已加入 $pkg"
}

$bundlePattern = '"bundles"\s*:\s*\[[^\]]*"' + [regex]::Escape($pkg) + '"'
if ($raw -notmatch $bundlePattern) {
    $bundleLine = '        "' + $pkg + '",'
    $bundleRe = [regex]'("bundles"\s*:\s*\[)'
    $raw = $bundleRe.Replace($raw, ('$1' + "`r`n" + $bundleLine), 1)
    Write-Host "  + dsh.profile.bundles 已加入 $pkg"
}

[IO.File]::WriteAllText($pkgFile, $raw)

Write-Host "完成。"
Write-Host "验证：重启 DSH 后，在左侧工作区的会话上右键，菜单末尾应出现红色「删除对话」。"
if ($Restart) { Invoke-RestartDsh } else { Write-Host "记得重启 DSH 才会生效。" }
