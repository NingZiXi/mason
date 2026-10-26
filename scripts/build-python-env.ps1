# 构建内置 Python CAD 引擎环境(打进安装包,用户零配置)
#
# 用法: npm run build:python-env
# 产物: src-tauri/resources/python-env/(gitignored,打包时由 Tauri resources 收进安装包)
#
# 流程: python.org 嵌入式发行版 → 启用 site-packages → pip(清华镜像)装
#       build123d shapely numpy → 清理 __pycache__ → 验证 import + server 冒烟
param(
  [string]$PythonVersion = "3.12.8",
  [string]$PypiMirror = "https://pypi.tuna.tsinghua.edu.cn/simple"
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path $PSScriptRoot -Parent
$dest = Join-Path $root "src-tauri\resources\python-env"
$tmp = Join-Path $env:TEMP "pcb-jig-python-env"

Write-Host "==> 清理旧环境..."
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
# .gitkeep 占位(此目录需在 git 中存在,内容不入库)
Set-Content -Path (Join-Path $dest ".gitkeep") -Value "# 由 build-python-env.ps1 管理"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Host "==> 下载 Python $PythonVersion 嵌入式发行版(python.org)..."
$embedZip = Join-Path $tmp "python-embed.zip"
Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" -OutFile $embedZip -UseBasicParsing

Write-Host "==> 解压..."
Expand-Archive -Path $embedZip -DestinationPath $dest -Force

# 嵌入式发行版默认禁用 site:改 ._pth 启用,并把 Lib\site-packages 加进搜索路径
Write-Host "==> 启用 site-packages..."
$pth = Get-ChildItem $dest -Filter "*._pth" | Select-Object -First 1
if (-not $pth) { throw "未找到 ._pth 文件(嵌入式发行版结构变了?)" }
$lines = @(Get-Content $pth.FullName) | ForEach-Object {
  if ($_ -eq "#import site") { "import site" } else { $_ }
}
if ($lines -notcontains "Lib\site-packages") { $lines += "Lib\site-packages" }
Set-Content -Path $pth.FullName -Value $lines -Encoding ASCII

$py = Join-Path $dest "python.exe"

Write-Host "==> 安装 pip..."
$getpip = Join-Path $tmp "get-pip.py"
Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getpip -UseBasicParsing
& $py $getpip --no-warn-script-location --quiet
if ($LASTEXITCODE -ne 0) { throw "get-pip 失败(exit $LASTEXITCODE)" }

Write-Host "==> 安装 CAD 依赖 build123d / shapely / numpy(镜像 $PypiMirror,约 200MB)..."
& $py -m pip install --no-warn-script-location --no-cache-dir -i $PypiMirror -r (Join-Path $root "python\requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "依赖安装失败(exit $LASTEXITCODE)" }

Write-Host "==> 裁剪未使用的渲染贴图..."
# threejs_materials 内含 86MB PNG 法线贴图,仅 three.js 材质渲染使用;
# 本项目只做几何建模与 STL/STEP 导出,已实测导入、三件套、钢网、server 全部正常
$texDir = Join-Path $dest "Lib\site-packages\threejs_materials"
if (Test-Path $texDir) {
  Get-ChildItem $texDir -Recurse -Filter "*.png" -File -ErrorAction SilentlyContinue | Remove-Item -Force
  Write-Host "    已移除 threejs_materials/*.png"
}

Write-Host "==> 清理缓存与字节码..."
Get-ChildItem $dest -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
Get-ChildItem $dest -Recurse -Filter "*.pyc" -File -ErrorAction SilentlyContinue | Remove-Item -Force

Write-Host "==> 验证 import..."
& $py -c "import build123d, shapely, numpy; print('deps OK')"
if ($LASTEXITCODE -ne 0) { throw "验证失败:依赖导入报错" }

# 生成器 server 模式冒烟(ping)
Write-Host "==> 验证 server 模式..."
$scriptPath = Join-Path $root "python\jig_generator.py"
$server = [System.Diagnostics.Process]::new()
$server.StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
$server.StartInfo.FileName = $py
$server.StartInfo.Arguments = "`"$scriptPath`" --server"
$server.StartInfo.UseShellExecute = $false
$server.StartInfo.RedirectStandardInput = $true
$server.StartInfo.RedirectStandardOutput = $true
$server.StartInfo.RedirectStandardError = $true
if (-not $server.Start()) { throw "server 冒烟启动失败" }
$stdoutTask = $server.StandardOutput.ReadToEndAsync()
$stderrTask = $server.StandardError.ReadToEndAsync()
$pingBytes = [System.Text.Encoding]::UTF8.GetBytes('{"id":1,"cmd":"ping"}' + "`n")
$server.StandardInput.BaseStream.Write($pingBytes, 0, $pingBytes.Length)
$server.StandardInput.BaseStream.Flush()
$server.StandardInput.Close()
if (-not $server.WaitForExit(60000)) {
  $server.Kill()
  $server.Dispose()
  throw "server 冒烟超时(60 秒)"
}
$pingResponse = $stdoutTask.Result.Trim()
$serverError = $stderrTask.Result
if ($server.ExitCode -ne 0) { throw "server 冒烟失败(exit $($server.ExitCode)): $serverError" }
$server.Dispose()
try { $ping = $pingResponse | ConvertFrom-Json } catch { throw "server 冒烟返回无效 JSON: $pingResponse`n$serverError" }
if (-not $ping.ok -or -not $ping.pong) { throw "server ping 失败: $pingResponse" }

$size = [math]::Round(((Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB)
Write-Host ""
Write-Host "==> 完成: $dest"
Write-Host "    体积: $size MB(打包时 NSIS 压缩约一半)"
