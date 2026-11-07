$ErrorActionPreference = 'Stop'
$secret = $null
$packet = $null
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Cần cài Node.js 24 để chạy script.' }
    Write-Host 'Mở trang thực nghiệm Enclave, xác nhận Windows Hello và bấm Sao chép gói xác nhận.'
    $secret = Read-Host 'Dán gói bằng Ctrl+V rồi Enter (nội dung được ẩn)' -AsSecureString
    $packet = [Net.NetworkCredential]::new('', $secret).Password.Trim()
    if ($packet -notmatch '\AENCLAVE-S2:[A-Za-z0-9+/]+=*\z' -or $packet.Length -gt 32768) { throw 'Gói xác nhận không đúng định dạng.' }
    # Chỉ xóa clipboard nếu nó còn đúng gói thực nghiệm vừa dán.
    try { if ((Get-Clipboard -Raw).Trim() -eq $packet) { Set-Clipboard -Value ' ' } } catch {}
    $packet | & node (Join-Path $PSScriptRoot 'S2-Enclave.cjs')
    $resultCode = $LASTEXITCODE
    if ($resultCode -ne 0) { Write-Host 'Lượt thực nghiệm chưa hoàn tất; kiểm tra đơn trên Enclave trước khi chạy lại.' -ForegroundColor Yellow }
} catch {
    Write-Host 'Chưa chạy được S2. Kiểm tra Node.js và gói xác nhận mới từ Enclave.' -ForegroundColor Yellow
    $resultCode = 1
} finally {
    $packet = $null
    if ($secret) { $secret.Dispose() }
}
exit $resultCode
