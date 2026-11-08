@echo off
chcp 65001 >nul
title Enclave - Thuc nghiem 1
pushd "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo May chua tim thay Node.js. Can cai Node.js truoc khi chay.
  pause
  popd
  exit /b 1
)
node "%~dp0S1-Enclave.cjs" --clipboard
set "S1_RESULT=%errorlevel%"
echo.
echo Giu cua so nay de xem hoac chup ket qua. Nhan phim bat ky khi muon dong.
pause >nul
popd
exit /b %S1_RESULT%
