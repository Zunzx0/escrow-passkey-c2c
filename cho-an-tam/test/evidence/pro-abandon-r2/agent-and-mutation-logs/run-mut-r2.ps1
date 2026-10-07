$sp  = 'C:\Users\tranq\AppData\Local\Temp\claude\C--Users-tranq\92364fc5-9355-4c27-8fb1-563ba2100e6f\scratchpad'
$wt  = 'C:\Users\tranq\Downloads\đồ án\claude-wt\paypal-abandon-request\cho-an-tam'
$mut = "$sp\abandon-mut\cho-an-tam"
$L   = 'C:\Users\tranq\tools\pro-release-heavy.lock'
while ($true) { try { New-Item -ItemType Directory $L -ErrorAction Stop | Out-Null; 'pro_lead_mut_r2' | Set-Content "$L\owner"; break } catch { Start-Sleep 5 } }
try {
  Copy-Item "$wt\test\paypal-abandonment-e2e.js" "$mut\test\paypal-abandonment-e2e.js" -Force
  $res = @()
  function Run-One($label, $idx) {
    Push-Location $mut
    $env:APP_ENV = 'test'; $env:DB_PATH = "data/test/mutr2-$label.db"; Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
    $log = "$sp\abandon-mutr2-$label.log"
    node --env-file=.env.test test/paypal-abandonment-e2e.js > $log 2> "$log.err"; $ec = $LASTEXITCODE
    Pop-Location
    $r = @(Select-String -Path $log -Pattern '❌' -Encoding UTF8 | % { $_.Line.Trim() })
    [pscustomobject]@{ mut = $label; exit = $ec; reds = $r.Count; first = (($r | select -First 2 | % { $_.Substring(0, [Math]::Min(110, $_.Length)) }) -join ' || ') }
  }
  robocopy "$wt\src" "$mut\src" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  $res += Run-One 'BASE' 0
  foreach ($i in 0..10) {
    $name = & powershell -NoProfile -File "$sp\abandon-mutate-r2.ps1" -Mut $i -Wt $wt -Root $mut
    if ($LASTEXITCODE -ne 0) { $res += [pscustomobject]@{ mut = "$i $($name -join ' ')"; exit = 'n/a'; reds = ''; first = 'NO MATCH' }; continue }
    $o = Run-One ("m$i") $i
    $o.mut = "$i $($name -join ' ')"
    $res += $o
  }
  robocopy "$wt\src" "$mut\src" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  $res | ft -auto -Wrap | Out-String -Width 260 | Out-File "$sp\mutr2-summary.txt" -Encoding utf8
  $res | ConvertTo-Json | Out-File "$sp\mutr2-summary.json" -Encoding utf8
}
finally {
  'DONE' | Out-File "$sp\mutr2-done.txt"
  Remove-Item -LiteralPath $L -Recurse -Force -ErrorAction SilentlyContinue
}
