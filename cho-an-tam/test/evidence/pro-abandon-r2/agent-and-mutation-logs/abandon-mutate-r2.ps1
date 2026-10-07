param([int]$Mut, $Wt, $Root)
$M = @(
 @{ n='R1 bo recovery_required_at IS NULL (nhom quet moi)'; f='src/lib/reconciler.js'; a="AND b.capture_state='READY' AND b.recovery_required_at IS NULL AND pr.created_at>?"; b="AND b.capture_state='READY' AND pr.created_at>?" },
 @{ n='R2 bo can cua so (WINDOW vo han)'; f='src/lib/reconciler.js'; a="const abandonedWindowHours = () => boundedEnvInt('PAYPAL_ABANDONED_SCAN_WINDOW_HOURS', 72, 24 * 30);"; b="const abandonedWindowHours = () => 1000000;" },
 @{ n='R3 bo gian cach RESCAN'; f='src/lib/reconciler.js'; a="const abandonedRescanSeconds = () => boundedEnvInt('PAYPAL_ABANDONED_RESCAN_SECONDS', 900, 7 * 24 * 3600);"; b="const abandonedRescanSeconds = () => 0;" },
 @{ n='R4a SHARE = limit (khong gioi han rieng)'; f='src/lib/reconciler.js'; a="share=Math.max(1,Math.floor(limit/5))"; b="share=limit" },
 @{ n='R4b gop hang muc (PENDING bi cat o limit)'; f='src/lib/reconciler.js'; a="for(const row of [...rows,...abandoned]) {"; b="for(const row of [...abandoned,...rows].slice(0,limit)) {" },
 @{ n='R5 bo capture_state READY'; f='src/lib/reconciler.js'; a="AND b.capture_state='READY' AND b.recovery_required_at IS NULL AND pr.created_at>?"; b="AND b.recovery_required_at IS NULL AND pr.created_at>?" },
 @{ n='R6 replay khong doc lai binding'; f='src/lib/paypalAbandonment.js'; a="const b = await store.loadByRequestId(id);"; b="const b = row;" },
 @{ n='R7 bo dieu kien lastError (CONFLICTING_CAPTURE...)'; f='src/lib/paypalAbandonment.js'; a="/^(CONFLICTING_CAPTURE|CAPTURED_AFTER_REQUEST_CLOSED)/.test(b.capture.lastError || '')"; b="false" },
 @{ n='R8 bo chan trung id'; f='src/lib/reconciler.js'; a=".filter(r=>!seen.has(r.id))"; b="" },
 @{ n='R9 paymentRequestId van kich hoat nhom moi'; f='src/lib/reconciler.js'; a="if(!paymentRequestId) {`r`n      const nowMs"; b="if(true) {`r`n      const nowMs" },
 @{ n='R10 clearError cho nhom abandon'; f='src/lib/reconciler.js'; a="if(!row.abandoned)await clearError(row.id);"; b="await clearError(row.id);" },
 @{ n='R13 ORDER BY thuan last_reconciled_at (bo COALESCE) o nhom moi'; f='src/lib/reconciler.js'; a="pr.last_reconciled_at<=?) ORDER BY COALESCE(pr.last_reconciled_at,pr.created_at) ASC LIMIT ?"; b="pr.last_reconciled_at<=?) ORDER BY pr.last_reconciled_at ASC LIMIT ?" }
)
if ($Mut -ge $M.Count) { "COUNT=$($M.Count)"; exit 7 }
$m = $M[$Mut]
robocopy "$Wt\src" "$Root\src" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
$p = Join-Path $Root $m.f
$s = [IO.File]::ReadAllText($p)
$a = $m.a
$c = ($s.Split([string[]]@($a), [StringSplitOptions]::None).Count - 1)
if ($c -ne 1) {
  # retry with LF-only variant of the anchor (files may be LF or CRLF)
  $a2 = $a.Replace("`r`n", "`n"); $c2 = ($s.Split([string[]]@($a2), [StringSplitOptions]::None).Count - 1)
  if ($c2 -eq 1) { $a = $a2; $m.b = $m.b.Replace("`r`n", "`n") } else { "NO-UNIQUE-MATCH($c/$c2): $($m.n)"; exit 9 }
}
$s = $s.Replace($a, $m.b)
[IO.File]::WriteAllText($p, $s)
$m.n
