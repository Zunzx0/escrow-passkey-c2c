$sp  = 'C:\Users\tranq\AppData\Local\Temp\claude\C--Users-tranq\92364fc5-9355-4c27-8fb1-563ba2100e6f\scratchpad'
$wt  = 'C:\Users\tranq\Downloads\đồ án\claude-wt\paypal-abandon-request\cho-an-tam'
$mut = "$sp\abandon-mut\cho-an-tam"
$L   = 'C:\Users\tranq\tools\pro-release-heavy.lock'
while ($true) { try { New-Item -ItemType Directory $L -ErrorAction Stop | Out-Null; 'pro_lead_mut_r2b' | Set-Content "$L\owner"; break } catch { Start-Sleep 5 } }
try {
  Copy-Item "$wt\test\paypal-abandonment-e2e.js" "$mut\test\paypal-abandonment-e2e.js" -Force
  $name = & powershell -NoProfile -File "$sp\abandon-mutate-r2.ps1" -Mut 11 -Wt $wt -Root $mut
  Push-Location $mut
  $env:APP_ENV = 'test'; $env:DB_PATH = 'data/test/mutr2-r13.db'; Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  node --env-file=.env.test test/paypal-abandonment-e2e.js > "$sp\abandon-mutr2-m11.log" 2> "$sp\abandon-mutr2-m11.log.err"; $ec = $LASTEXITCODE
  Pop-Location
  robocopy "$wt\src" "$mut\src" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  "R13 name: $($name -join ' ') exit=$ec" | Out-File "$sp\mutr2b-summary.txt" -Encoding utf8
}
finally {
  'DONE' | Out-File "$sp\mutr2b-done.txt"
  Remove-Item -LiteralPath $L -Recurse -Force -ErrorAction SilentlyContinue
}
