'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const API='https://api.enclave.id.vn',WEB='https://enclave.id.vn';
const idPattern=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
function fail(text){throw Object.assign(new Error(text),{safeMessage:text});}
function decode(text){
  if(typeof text!=='string'||text.length>16384||!/^ENCLAVE-S1:[A-Za-z0-9+/]+=*$/.test(text))fail('Trên Enclave bấm Sao chép phiên thử nghiệm, rồi mở Chay-S1.cmd.');
  let data;try{data=JSON.parse(Buffer.from(text.slice(11),'base64').toString('utf8'));}catch{fail('Gói phiên không đọc được. Hãy sao chép lại trên Enclave.');}
  const fields=['version','apiOrigin','webOrigin','transactionId','accessToken','expiresAt'];
  if(!data||Object.keys(data).some(key=>!fields.includes(key))||data.version!=='ENCLAVE-S1-1'||data.apiOrigin!==API||data.webOrigin!==WEB)fail('Gói không đúng loại phiên thử nghiệm S1. Không dùng gói phiếu Passkey của S2.');
  if(!idPattern.test(data.transactionId||'')||typeof data.accessToken!=='string'||!/^[-\w]+\.[-\w]+\.[-\w]+$/.test(data.accessToken))fail('Gói thiếu mã đơn hoặc mã phiên hợp lệ.');
  if(!Number.isFinite(Date.parse(data.expiresAt))||Date.parse(data.expiresAt)<=Date.now())fail('Mã phiên đã hết hạn. Kiểm tra đơn và sao chép phiên mới trên Enclave.');
  return data;
}
async function http(token,route,body){
  try{
    const r=await fetch(API+'/api'+route,{method:body===undefined?'GET':'POST',headers:{Origin:WEB,Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(12000)});
    if(!/application\/json/i.test(r.headers.get('content-type')||''))fail('Phản hồi máy chủ chưa đọc được.');
    return {status:r.status,data:await r.json()};
  }catch{fail('Kết nối bị gián đoạn. Không tự gửi lại lệnh; kiểm tra đơn trên Enclave trước khi thử tiếp.');}
}
function errorCode(reply){return /^[A-Z0-9_]{1,80}$/.test(reply.data?.error||'')?reply.data.error:null;}
function expectRead(reply){if(reply.status!==200||errorCode(reply))fail(`Chưa xác nhận được phiên hoặc dữ liệu (HTTP ${reply.status} / ${errorCode(reply)||'không có mã lỗi'}). Chưa đủ cơ sở kết luận bảo vệ đạt.`);return reply.data;}
const num=value=>{const n=Number(value);if(value==null||value===''||!Number.isSafeInteger(n)||n<0)fail('Số liệu máy chủ không hợp lệ.');return n;};
async function open(packet,transport=http){
  const data=decode(packet),trace=[];
  const ctx={id:data.transactionId,trace};
  ctx.request=async(route,body)=>{
    const started=performance.now(),reply=await transport(data.accessToken,route,body),durationMs=Number((performance.now()-started).toFixed(2));
    trace.push({method:body===undefined?'GET':'POST',route,status:reply.status,error:errorCode(reply),durationMs});return {...reply,durationMs};
  };
  const me=expectRead(await ctx.request('/users/me'));if(!me.user?.id)fail('Không xác nhận được chủ phiên.');
  ctx.userId=me.user.id;ctx.before=await inspect(ctx);
  const order=ctx.before.order;
  if(order.buyerId!==ctx.userId||order.status!=='WAIT_CONFIRM'||order.escrowStatus!=='LOCKED'||!order.inspectedAt||order.blocked||ctx.before.releaseEvents!==0)fail('Đơn phải thuộc người mua đang đăng nhập, đã kiểm hàng và chưa chuyển tiền.');
  return ctx;
}
async function inspect(ctx){
  const [tr,wr,lr]=await Promise.all([ctx.request('/transactions/'+ctx.id),ctx.request('/wallets/me'),ctx.request('/transactions/'+ctx.id+'/logs')]);
  const t=expectRead(tr),w=expectRead(wr),logs=expectRead(lr).logs;
  if(t.id!==ctx.id||!Array.isArray(logs))fail('Dữ liệu đối chiếu không đúng đơn.');
  return {order:{id:t.id,buyerId:t.buyerId,sellerId:t.sellerId,amount:num(t.amount),status:t.status,escrowStatus:t.escrowStatus,version:num(t.version),inspectedAt:t.inspectedAt,blocked:Boolean(t.integrityHold)},wallet:{id:w.id,available:num(w.availableBalance),locked:num(w.lockedBalance),version:num(w.version)},releaseEvents:logs.filter(row=>row.action==='ESCROW_RELEASED').length};
}
function verdict(ctx,reply,before,after){
  let unchanged=true;try{assert.deepEqual(after,before);}catch{unchanged=false;}
  const code=errorCode(reply),blocked=reply.status===401&&code==='REAUTH_REQUIRED';
  return {complete:blocked&&unchanged,target:API,sessionReadStatus:200,assumption:'Controlled copy of a test account session; no XSS exploitation or real credential theft.',
    attempt:{status:reply.status,error:code,durationMs:reply.durationMs},unchanged,before,after,httpTrace:ctx.trace,
    ownerPasskeyPositiveControl:false,limits:'API checks buyer wallet, order and release audit count; global wallet/ledger reconciliation is separate.'};
}
function windowsCommand(command,executor=execFileSync){
  const executable=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),env={};
  for(const k of ['SystemRoot','WINDIR','PATH','Path','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[k])env[k]=process.env[k];
  return executor(executable,['-NoLogo','-NoProfile','-NonInteractive','-STA','-Command',command],{encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:32768,env,stdio:['ignore','pipe','pipe']});
}
function readClipboard(executor){let text;try{text=String(windowsCommand('Get-Clipboard -Raw -ErrorAction Stop',executor)).trim();}catch{fail('Chưa đọc được gói đã sao chép trên Enclave.');}decode(text);return text;}
function clearMatchingClipboard(packet,executor){
  const hash=createHash('sha256').update(packet).digest('hex');
  const command="$v=Get-Clipboard -Raw -ErrorAction Stop;if($v){$h=[Security.Cryptography.SHA256]::Create();try{$s=[BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($v.Trim()))).Replace('-','').ToLowerInvariant();if($s -eq '"+hash+"'){Set-Clipboard -Value ' ' -ErrorAction Stop}}finally{$h.Dispose()}}";
  try{windowsCommand(command,executor);}catch{}
}
function save(result){const dir=path.join(__dirname,'results');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'S1-'+randomUUID()+'.json');fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});return file;}
function report(result){
  const money=n=>Number(n).toLocaleString('vi-VN')+'đ';
  console.log('\nKẾT QUẢ THỰC NGHIỆM 1 — ENCLAVE.ID.VN\n');
  console.log('GET /api/users/me: HTTP '+result.sessionReadStatus+' — phiên hợp lệ.');
  console.log('POST /api/transactions/'+result.before.order.id+'/release');
  console.log('HTTP '+result.attempt.status+' / '+(result.attempt.error||'không có mã lỗi'));
  console.log(result.complete?'BỊ CHẶN ĐÚNG ĐIỀU KIỆN; DỮ LIỆU ĐỐI CHIẾU GIỮ NGUYÊN.':'KẾT QUẢ KHÁC DỰ KIẾN; CẦN KIỂM TRA ĐƠN VÀ DÒNG TIỀN.');
  console.log('Trạng thái đơn: '+result.before.order.status+' -> '+result.after.order.status);
  console.log('Trạng thái tiền: '+result.before.order.escrowStatus+' -> '+result.after.order.escrowStatus);
  console.log('Ví người mua: '+money(result.before.wallet.available)+' -> '+money(result.after.wallet.available));
  console.log('Sự kiện chuyển tiền: '+result.before.releaseEvents+' -> '+result.after.releaseEvents);
  console.log(result.complete?'Bước tiếp theo: chính chủ mở đơn trên web và xác nhận Windows Hello làm đối chứng.':'Giữ nguyên đơn để kiểm tra; chưa chạy bước chuyển tiền đối chứng.');
}
async function cli(run,{clipboard=false}={}){
  let packet=null;
  try{
    if(clipboard)console.log('Tự đọc phiên thử nghiệm đã sao chép. Không dán hoặc nhập PIN/mật khẩu vào cửa sổ này.');
    packet=clipboard?readClipboard():fs.readFileSync(0,'utf8').trim();if(clipboard)clearMatchingClipboard(packet);
    const result=await run(packet);report(result);process.exitCode=result.complete?0:1;
    try{console.log('Đã lưu tại results/'+path.basename(save(result)));}catch{console.error('Chưa lưu được tệp; giữ cửa sổ để chụp, không tự gửi lại lệnh.');if(result.complete)process.exitCode=2;}
  }catch(error){
    const reason=error.safeMessage||'Chưa xác định được kết quả. Kiểm tra trạng thái đơn trên Enclave trước khi thử tiếp.';
    console.error('S1 CHƯA HOÀN TẤT: '+reason);process.exitCode=1;
    try{save({complete:false,target:API,reason,ownerPasskeyPositiveControl:false});}catch{}
  }finally{packet=null;}
}
module.exports={open,inspect,verdict,cli,decode,readClipboard,clearMatchingClipboard};
