param(
    [string]$Server = '192.168.1.200',
    [string]$SshUser = 'loql',
    [string]$Image = '.cache/k6-test/mushroom.jpg',
    [string]$K6 = '.cache/k6/k6-v2.3.0-windows-amd64/k6.exe',
    [string]$Python = 'C:/Users/loql/AppData/Local/Python/pythoncore-3.12-64/python.exe',
    [switch]$Smoke,
    [ValidateSet('All', 'Small', 'Main', 'MainCold', 'MainWarm')][string]$Suite = 'All'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'smoke-readiness.ps1')
. (Join-Path $PSScriptRoot 'isolation-policy.ps1')
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
    Write-Host 'Running an isolated 10-VU smoke test before the benchmark suite.'
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
    try { Remote "cd $remoteDir && sh benchmarks/k6/remote-stack.sh $action $taskRun$suffix" }
    catch { throw "Remote benchmark action '$action' failed for project $taskRun. See SSH output above. $_" }
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
$completedSmoke = $false
try {
Stack 'prepare'
Stack 'seed' @($(if ($Smoke) { 'smoke' } else { 'full' }))
Run 'scp' @('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',"$target`:$remoteDir/.cache/benchmark/$taskRun/manifest.json",(Join-Path $localCache 'manifest.json'))
Run 'scp' @('-r','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',"$target`:$remoteDir/.cache/benchmark/$taskRun/index-evidence",$resultsRoot)
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
    $prometheusReady = $false
    try { $prometheusReady = ((Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:9090/-/ready' -TimeoutSec 3).StatusCode -eq 200) } catch {}
    if (-not $prometheusReady) {
        $passwordFile = Join-Path $toolDir 'grafana-local-password.txt'
        if (-not (Test-Path -LiteralPath $passwordFile)) { ([Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')) | Set-Content -LiteralPath $passwordFile -NoNewline }
        $env:GRAFANA_BENCHMARK_PASSWORD = Get-Content -Raw -LiteralPath $passwordFile
        Run 'docker' @('compose','-p','dacs-benchmark-monitoring','-f','benchmarks/k6/monitoring/compose.yaml','up','-d')
        Remove-Item Env:GRAFANA_BENCHMARK_PASSWORD
    }
    $cases = @()
    if ($Smoke) {
        Stack 'snapshot'
        foreach ($cache in @('off','cold','warm')) { $cases += [PSCustomObject]@{ distribution='uniform'; cache=$cache; vus=0; name="smoke-$cache" } }
    }
    else {
        Stack 'snapshot'
        if ($Suite -in @('All', 'Small')) {
            foreach ($distribution in @('uniform', 'hot')) { foreach ($cache in @('off','cold','warm')) { foreach ($vus in @(5,10,25,50,100)) {
                $cases += [PSCustomObject]@{ distribution=$distribution; cache=$cache; vus=$vus; name="small-$distribution-$cache-$vus" }
            } } }
        }
        if ($Suite -in @('All', 'Main')) { foreach ($cache in @('cold','warm')) {
            $cases += [PSCustomObject]@{ distribution='hot'; cache=$cache; vus=0; name="main-hot-$cache" }
        } }
        if ($Suite -eq 'MainCold') { $cases += [PSCustomObject]@{ distribution='hot'; cache='cold'; vus=0; name='main-hot-cold' } }
        if ($Suite -eq 'MainWarm') { $cases += [PSCustomObject]@{ distribution='hot'; cache='warm'; vus=0; name='main-hot-warm' } }
    }
    foreach ($case in $cases) {
        Stack 'configure' @(2,1,10,$(if ($case.cache -eq 'off') { 'false' } else { 'true' }))
        Stack 'reset'
        Authenticate
        $env:BENCHMARK_DISTRIBUTION = $case.distribution
        $env:BENCHMARK_CACHE_CASE = $case.cache
        $env:BENCHMARK_CASE_ID = "$taskRun-$($case.name)"
        $env:BENCHMARK_RANDOM_SEED = '1234567'
        if ($case.vus) { $env:BENCHMARK_STEP_VUS = [string]$case.vus } else { Remove-Item Env:BENCHMARK_STEP_VUS -ErrorAction SilentlyContinue }
        $env:RESULTS_DIR = Join-Path $resultsRoot $case.name
        & node benchmarks/k6/run-benchmark.cjs
        $runExit = $LASTEXITCODE
        if (($Smoke -and $runExit -ne 0) -or $runExit -notin @(0,99)) { throw "Benchmark incomplete ($runExit); inspect $env:RESULTS_DIR" }
        $analysisFile = Join-Path $env:RESULTS_DIR 'analysis.json'
        if (Test-Path -LiteralPath $analysisFile) {
            $analysis = Get-Content -Raw -Encoding UTF8 -LiteralPath $analysisFile | ConvertFrom-Json
            Assert-IsolationOutcome $analysis $analysisFile
        }
        if ($Smoke) {
            $readiness = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $env:RESULTS_DIR 'readiness.json') | ConvertFrom-Json
            Assert-SmokeReadiness $readiness
        }
    }
    if ($Smoke) {
        Stack 'cleanup'
        $completedSmoke = $true
    }
    Write-Host "Finished $taskRun; results: $resultsRoot"
} finally {
    if (-not $Smoke -or -not $completedSmoke) {
        try { Stack 'stop' } catch { Write-Warning "Could not stop benchmark project $taskRun; data was retained." }
    }
    if (-not $Smoke -and (Test-Path -LiteralPath $resultsRoot)) { & node benchmarks/k6/suite-summary.cjs $resultsRoot }
    Remove-Item Env:BENCHMARK_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:SSH_PRIVATE_KEY -ErrorAction SilentlyContinue
}
