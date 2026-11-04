function Assert-SmokeReadiness($readiness) {
    if ($readiness.ready) { return }
    $missing = @($readiness.missing)
    if ($missing.Count -ne 1 -or $missing[0] -notmatch 'prometheus_vus \(>=95%, .+ <=15 .+\)$') {
        throw 'Smoke lacks required monitoring, metadata or coverage; inspect readiness.json'
    }
    Write-Warning 'Smoke Prometheus VU sampling is incomplete; see readiness.json. The full benchmark still requires complete evidence.'
}
