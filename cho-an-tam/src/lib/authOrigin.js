const {ORIGIN}=require('./webauthnConfig');

// CORS controls response visibility, not whether a simple request changes state.
// Cookie-based authentication must reject an untrusted Origin even for same-site subdomains.
function authOrigin(req,res,next) {
  if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
  const allowed=new Set([ORIGIN,...String(process.env.CORS_ORIGIN||'').split(',').map(v=>v.trim()).filter(Boolean)]);
  if(process.env.AUTH_PUBLIC_URL)allowed.add(new URL(process.env.AUTH_PUBLIC_URL).origin);
  const origin=req.headers.origin;
  if((origin&&!allowed.has(origin))||(!origin&&req.headers.cookie)) {
    return res.status(403).json({error:'ORIGIN_NOT_ALLOWED',message:'Yêu cầu bảo mật không đến từ trang Enclave được phép.'});
  }
  return next();
}
module.exports={authOrigin};
