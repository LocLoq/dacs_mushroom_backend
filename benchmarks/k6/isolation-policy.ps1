function Assert-IsolationOutcome($analysis, [string]$analysisFile) {
    $failed = [int]$analysis.isolation_checks.fails
    if ($failed -le 0) { return }
    $outcomes = $analysis.isolation_outcomes
    if ($null -eq $outcomes) { throw "Facility isolation failures are unclassified; inspect $analysisFile" }
    if ([int]$outcomes.violation -gt 0) { throw "Facility isolation violation detected; inspect $analysisFile" }
    if ([int]$outcomes.mismatch -gt 0) { throw "Facility report totals differed; inspect $analysisFile" }
    if ([int]$outcomes.inconclusive -ne $failed) { throw "Facility isolation failures are unclassified; inspect $analysisFile" }
    Write-Warning "Facility isolation could not be verified for $failed probes; the result remains not ready. See $analysisFile."
}
