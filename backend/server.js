import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pg from 'pg';

const { Pool } = pg;
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean) }));
app.use(express.json({ limit: '12kb' }));
app.use('/api/', rateLimit({ windowMs: 900000, limit: 40 }));
const clean = (v, n=160) => typeof v === 'string' ? v.trim().replace(/[<>]/g, '').slice(0,n) : '';
const validPhone = v => /^[6-9]\d{9}$/.test(v);
const admin = (req,res,next) => {
 const key = process.env.ADMIN_API_KEY;
 const token = req.get('authorization')?.replace(/^Bearer\s+/i,'') || '';
 if (!key) return res.status(503).json({error:'Admin access is not configured.'});
 if (token.length !== key.length || !Buffer.from(token).equals(Buffer.from(key))) return res.status(401).json({error:'Unauthorized.'});
 next();
};
app.get('/api/health', async (_req,res) => {
 try {
  await pool.query('SELECT 1');
  const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('customer_enquiries','provider_applications')");
  res.json({ok:true,service:'repairdesk-api',database:'connected',tables:tables.rows.map(r=>r.table_name)});
 } catch { res.status(503).json({ok:false,error:'Database unavailable.'}); }
});
app.post('/api/enquiries', async (req,res) => {
 const model=clean(req.body?.model,100), issue=clean(req.body?.issue,100), area=clean(req.body?.area,120), phone=clean(req.body?.phone,10);
 if (!model || !issue || !area || !validPhone(phone)) return res.status(400).json({error:'Enter device, issue, area and a valid 10-digit mobile number.'});
 try { const q=await pool.query('INSERT INTO customer_enquiries(model,issue,area,phone) VALUES($1,$2,$3,$4) RETURNING id,status,created_at',[model,issue,area,phone]); res.status(201).json({message:'Enquiry received. This is not a confirmed booking.',enquiry:q.rows[0]}); }
 catch(e) { console.error(e.message); res.status(500).json({error:'Could not save enquiry. Try again later.'}); }
});
app.post('/api/provider-applications', async (req,res) => {
 const business=clean(req.body?.business,120), contact=clean(req.body?.contact,100), area=clean(req.body?.area,120), phone=clean(req.body?.phone,10), service=clean(req.body?.service,120), experience=clean(req.body?.experience,80);
 if (!business || !contact || !area || !validPhone(phone) || !service) return res.status(400).json({error:'Complete required fields and enter a valid 10-digit mobile number.'});
 try { const q=await pool.query('INSERT INTO provider_applications(business,contact,area,phone,service,experience) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,status,created_at',[business,contact,area,phone,service,experience||null]); res.status(201).json({message:'Application received. Public listing requires manual verification.',application:q.rows[0]}); }
 catch(e) { console.error(e.message); res.status(500).json({error:'Could not save application. Try again later.'}); }
});
app.get('/api/admin/enquiries',admin,async (_req,res)=>{try{const q=await pool.query('SELECT id,model,issue,area,phone,status,created_at FROM customer_enquiries ORDER BY created_at DESC LIMIT 200');res.json({enquiries:q.rows});}catch(e){console.error(e.message);res.status(500).json({error:'Could not load enquiries.'});}});
app.get('/api/admin/providers',admin,async (_req,res)=>{try{const q=await pool.query('SELECT id,business,contact,area,phone,service,experience,status,created_at FROM provider_applications ORDER BY created_at DESC LIMIT 200');res.json({applications:q.rows});}catch(e){console.error(e.message);res.status(500).json({error:'Could not load applications.'});}});
app.patch('/api/admin/enquiries/:id',admin,async(req,res)=>{const status=clean(req.body?.status,20);if(!/^\d+$/.test(req.params.id)||!['new','reviewing','matched','closed','spam'].includes(status))return res.status(400).json({error:'Invalid ID or status.'});try{const q=await pool.query('UPDATE customer_enquiries SET status=$1 WHERE id=$2 RETURNING id,status',[status,req.params.id]);if(!q.rowCount)return res.status(404).json({error:'Not found.'});res.json({enquiry:q.rows[0]});}catch(e){console.error(e.message);res.status(500).json({error:'Update failed.'});}});
app.delete('/api/admin/enquiries/:id',admin,async(req,res)=>{if(!/^\\d+$/.test(req.params.id))return res.status(400).json({error:'Invalid ID.'});try{const q=await pool.query('DELETE FROM customer_enquiries WHERE id=$1 RETURNING id',[req.params.id]);if(!q.rowCount)return res.status(404).json({error:'Not found.'});res.json({deleted:true,id:q.rows[0].id});}catch(e){console.error(e.message);res.status(500).json({error:'Delete failed.'});}});
app.delete('/api/admin/providers/:id',admin,async(req,res)=>{if(!/^\\d+$/.test(req.params.id))return res.status(400).json({error:'Invalid ID.'});try{const q=await pool.query('DELETE FROM provider_applications WHERE id=$1 RETURNING id',[req.params.id]);if(!q.rowCount)return res.status(404).json({error:'Not found.'});res.json({deleted:true,id:q.rows[0].id});}catch(e){console.error(e.message);res.status(500).json({error:'Delete failed.'});}});
app.patch('/api/admin/providers/:id',admin,async(req,res)=>{const status=clean(req.body?.status,20);if(!/^\d+$/.test(req.params.id)||!['pending','reviewing','verified','rejected'].includes(status))return res.status(400).json({error:'Invalid ID or status.'});try{const q=await pool.query('UPDATE provider_applications SET status=$1 WHERE id=$2 RETURNING id,status',[status,req.params.id]);if(!q.rowCount)return res.status(404).json({error:'Not found.'});res.json({application:q.rows[0]});}catch(e){console.error(e.message);res.status(500).json({error:'Update failed.'});}});
app.use((_req,res)=>res.status(404).json({error:'Route not found.'}));

async function start() {
  await pool.query(`CREATE TABLE IF NOT EXISTS customer_enquiries (
    id BIGSERIAL PRIMARY KEY,
    model TEXT NOT NULL,
    issue TEXT NOT NULL,
    area TEXT NOT NULL,
    phone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS provider_applications (
    id BIGSERIAL PRIMARY KEY,
    business TEXT NOT NULL,
    contact TEXT NOT NULL,
    area TEXT NOT NULL,
    phone TEXT NOT NULL,
    service TEXT NOT NULL,
    experience TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  app.listen(Number(process.env.PORT||4000),'0.0.0.0',()=>console.log('RepairDesk API listening; database schema ready'));
}
start().catch(error => {
  console.error('RepairDesk startup failed:', error.message);
  process.exit(1);
});
