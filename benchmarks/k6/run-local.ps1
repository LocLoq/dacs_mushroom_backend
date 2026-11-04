param(
    [string]$Server = '192.168.1.200',
    [string]$SshUser = 'loql',
    [string]$Image = '.cache/k6-test/mushroom.jpg',
    [string]$K6 = '.cache/k6/k6-v2.3.0-windows-amd64/k6.exe',
    [string]$Python = 'C:/Users/loql/AppData/Local/Python/pythoncore-3.12-64/python.exe',
    [switch]$Smoke
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'smoke-readiness.ps1')
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $repo
if ($Server -notmatch '^[A-Za-z0-9.-]+$' -or $SshUser -notmatch '^[a-z_][a-z0-9_-]*$') { throw 'Invalid SSH host or user' }
foreach ($path in @($Image, $K6, $Python)) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing required path: $path" } }
$Image = (Resolve-Path -LiteralPath $Image).Path
$K6 = (Resolve-Path -LiteralPath $K6).Path
$Python = (Resolve-Path -LiteralPath $Python).Path
$taskRun = 'bm' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$target = "$SshUser@$Server"
$remoteDir = "/home/$SshUser/benchmark_$taskRun"
$localCache = Join-Path $repo ".cache/benchmark/$taskRun"
$resultsRoot = Join-Path $repo ".cache/benchmark-results/$taskRun"
$toolDir = Join-Path $repo '.cache/benchmark-tools'
$key = Join-Path $env:USERPROFILE '.ssh/id_ed25519'
$knownHosts = Join-Path $env:USERPROFILE '.ssh/known_hosts'
if (-not (Test-Path -LiteralPath $key) -or -not (Test-Path -LiteralPath $knownHosts)) { throw 'SSH private key and verified known_hosts are required' }
if (-not $Smoke) {
    Write-Host 'Running an isolated 10-VU smoke test before the full benchmark.'
    & powershell -NoProfile -File $PSCommandPath -Server $Server -SshUser $SshUser -Image $Image -K6 $K6 -Python $Python -Smoke
    if ($LASTEXITCODE -ne 0) { throw 'Smoke test failed; full benchmark was not started' }
}
New-Item -ItemType Directory -Force -Path $localCache, $resultsRoot, $toolDir | Out-Null
Copy-Item -LiteralPath $knownHosts -Destination (Join-Path $toolDir 'known_hosts') -Force
function Run([string]$exe, [string[]]$commandArgs) {
    & $exe @commandArgs
    if ($LASTEXITCODE -ne 0) { throw "$exe failed with exit $LASTEXITCODE" }
}
function Remote([string]$command) { Run 'ssh' @('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',$target,$command) }
function Stack([string]$action, [string[]]$arguments = @()) {
    $suffix = if ($arguments.Count) { ' ' + ($arguments -join ' ') } else { '' }
    Remote "cd $remoteDir && sh benchmarks/k6/remote-stack.sh $action $taskRun$suffix"
}
if (-not (Test-Path (Join-Path $toolDir 'node_modules/ssh2/package.json'))) {
    Run 'npm' @('install','--prefix',$toolDir,'ssh2@1.17.0','--no-save')
}
& $Python -c 'import PIL, matplotlib'
if ($LASTEXITCODE -ne 0) { throw 'Python requires Pillow and Matplotlib' }
Run $K6 @('version')
$archive = Join-Path $localCache 'source.tar'
$sources = @('.dockerignore','compose.yaml','compose.benchmark.yaml','package.json','package-lock.json','prisma.config.ts','swagger.yaml','server.cjs','classifier-worker.cjs','config','docker','routes','middlewares','services','queues','jobs','prisma','sql','scripts','helper','benchmarks/k6')
Run 'tar' (@('-cf',$archive) + $sources)
Remote "mkdir $remoteDir"
Run 'scp' @('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',$archive,"$target`:$remoteDir/source.tar")
Run 'scp' @('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',$Image,"$target`:$remoteDir/fixture.jpg")
Remote "cd $remoteDir && tar -xf source.tar"
Stack 'prepare'
Stack 'seed' @($(if ($Smoke) { 'smoke' } else { 'full' }))
Run 'scp' @('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',"$target`:$remoteDir/.cache/benchmark/$taskRun/manifest.json",(Join-Path $localCache 'manifest.json'))
$env:BENCHMARK_RUN_ID = $taskRun
$env:BASE_URL = "http://$Server`:18080"
$env:BENCHMARK_PASSWORD = (& ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $target "cd $remoteDir && . ./.env.benchmark && printf '%s' `"`$BENCHMARK_PASSWORD`"")
if ($LASTEXITCODE -ne 0 -or $env:BENCHMARK_PASSWORD.Length -lt 12) { throw 'Cannot read benchmark-only credential over SSH' }
function Authenticate { Run 'node' @('benchmarks/k6/authenticate.cjs') }
Authenticate
$env:SESSIONS_PATH = Join-Path $localCache 'sessions.json'
$env:BENCHMARK_IMAGE = $Image
$env:K6_PATH = $K6
$env:BENCHMARK_MODE = 'capacity'
$env:BENCHMARK_CAPACITY_CONFIRMED = '1'
$env:BENCHMARK_SOURCE_IP_COUNT = '1'
$env:BENCHMARK_COMPOSE_PROJECT = $taskRun
$env:BENCHMARK_REMOTE_REPO = $remoteDir
$env:SSH_HOST = $Server
$env:SSH_USER = $SshUser
$env:SSH_PRIVATE_KEY = $key
$env:BENCHMARK_TOOLS = $toolDir
$env:BENCHMARK_PYTHON = $Python
$env:K6_PROMETHEUS_RW_SERVER_URL = 'http://127.0.0.1:9090/api/v1/write'
try {
    $prometheusReady = $false
    try { $prometheusReady = ((Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:9090/-/ready' -TimeoutSec 3).StatusCode -eq 200) } catch {}
    if (-not $prometheusReady) {
        $passwordFile = Join-Path $toolDir 'grafana-local-password.txt'
        if (-not (Test-Path -LiteralPath $passwordFile)) { ([Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')) | Set-Content -LiteralPath $passwordFile -NoNewline }
        $env:GRAFANA_BENCHMARK_PASSWORD = Get-Content -Raw -LiteralPath $passwordFile
        Run 'docker' @('compose','-p','dacs-benchmark-monitoring','-f','benchmarks/k6/monitoring/compose.yaml','up','-d')
        Remove-Item Env:GRAFANA_BENCHMARK_PASSWORD
    }
    if (-not $Smoke) {
        $candidates = @()
        foreach ($pair in @(@(1,4),@(1,2),@(1,1),@(2,1))) {
            Stack 'configure' @($pair[0],$pair[1],10)
            $raw = @(& ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $target "cd $remoteDir && sh benchmarks/k6/remote-stack.sh calibrate $taskRun $($pair[0])")
            if ($LASTEXITCODE -ne 0) { throw 'Classifier calibration failed' }
            $data = $raw[-1] | ConvertFrom-Json
            $candidates += [PSCustomObject]@{ concurrency=$pair[0]; threads=$pair[1]; throughput=$data.throughput; p95_ms=$data.p95_ms; errors=$data.errors; succeeded=$data.succeeded }
        }
        $candidates | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resultsRoot 'classifier-calibration.json') -Encoding UTF8
        $best = $candidates | Sort-Object @{Expression='throughput';Descending=$true}, @{Expression='p95_ms';Descending=$false} | Select-Object -First 1
        $poolResults = @()
        foreach ($pool in @(10,20)) {
            Stack 'configure' @($best.concurrency,$best.threads,$pool)
            $since = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            $env:BENCHMARK_CALIBRATION_VUS = '100'
            $env:RESULTS_DIR = Join-Path $resultsRoot "pool-$pool"
            & node benchmarks/k6/run-benchmark.cjs
            if ($LASTEXITCODE -notin @(0,99)) { throw "Pool calibration $pool failed" }
            $summary = Get-Content -Raw -LiteralPath (Join-Path $env:RESULTS_DIR 'analysis.json') | ConvertFrom-Json
            $poolErrors = & ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $target "docker logs --since $since $taskRun-api-1 2>&1 | grep -c 'pool timeout: failed to retrieve a connection from pool' || true"
            $poolResults += [PSCustomObject]@{ pool=$pool; pool_errors=[int]$poolErrors; p95_ms=$summary.read_latency_ms.'p(95)' }
        }
        Remove-Item Env:BENCHMARK_CALIBRATION_VUS
        $poolResults | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resultsRoot 'pool-calibration.json') -Encoding UTF8
        $chosen = $poolResults | Sort-Object pool_errors, p95_ms, pool | Select-Object -First 1
        Stack 'configure' @($best.concurrency,$best.threads,$chosen.pool)
        Authenticate
    }
    $env:RESULTS_DIR = Join-Path $resultsRoot 'measured'
    & node benchmarks/k6/run-benchmark.cjs
    if ($Smoke -and $LASTEXITCODE -ne 0) { throw 'Smoke test did not pass; inspect metadata and logs' }
    if ($LASTEXITCODE -notin @(0,99)) {
        $metadataFile = Join-Path $env:RESULTS_DIR 'metadata.json'
        if (Test-Path -LiteralPath $metadataFile) {
            $failure = Get-Content -Raw -Encoding UTF8 -LiteralPath $metadataFile | ConvertFrom-Json
            if ($failure.error) { throw "Benchmark incomplete: $($failure.error). See $metadataFile" }
        }
        throw "Benchmark incomplete; inspect metadata and logs in $env:RESULTS_DIR"
    }
    if ($Smoke) {
        $readiness = Get-Content -Raw -LiteralPath (Join-Path $env:RESULTS_DIR 'readiness.json') | ConvertFrom-Json
        Assert-SmokeReadiness $readiness
        Stack 'cleanup'
    }
    Write-Host "Finished $taskRun; results: $env:RESULTS_DIR; k6 exit: $LASTEXITCODE"
} finally {
    Remove-Item Env:BENCHMARK_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:SSH_PRIVATE_KEY -ErrorAction SilentlyContinue
}
