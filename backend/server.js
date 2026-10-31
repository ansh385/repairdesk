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

app.get('/api/health', async (_req,res) => {
 try {
  await pool.query('SELECT 1');
  res.json({ok:true,service:'repairdesk-api',database:'connected'});
 } catch { res.status(503).json({ok:false,error:'Database unavailable.'}); }
});

// Public directory: profiles are self-published by providers and are explicitly not identity-verified by RepairDesk.
app.get('/api/providers', async (req,res) => {
 const area=clean(req.query.area,120), service=clean(req.query.service,120), search=clean(req.query.q,100);
 try {
  const q=await pool.query(`
   SELECT id,business,area,phone,service,experience,created_at
   FROM provider_applications
   WHERE status='published'
    AND ($1='' OR area ILIKE '%'||$1||'%')
    AND ($2='' OR service ILIKE '%'||$2||'%')
    AND ($3='' OR business ILIKE '%'||$3||'%' OR service ILIKE '%'||$3||'%' OR area ILIKE '%'||$3||'%')
   ORDER BY created_at DESC LIMIT 100
  `,[area,service,search]);
  res.json({providers:q.rows});
 } catch(e) { console.error(e.message); res.status(500).json({error:'Could not load provider directory.'}); }
});

app.post('/api/provider-applications', async (req,res) => {
 const business=clean(req.body?.business,120), area=clean(req.body?.area,120), phone=clean(req.body?.phone,10), service=clean(req.body?.service,120), experience=clean(req.body?.experience,80);
 if (!business || !area || !validPhone(phone) || !service) return res.status(400).json({error:'Enter a business name, service area, service and valid 10-digit WhatsApp number.'});
 try {
  const q=await pool.query(`INSERT INTO provider_applications(business,contact,area,phone,service,experience,status)
   VALUES($1,$2,$3,$4,$5,$6,'published') RETURNING id,business,area,service`,
   [business,business,area,phone,service,experience||null]);
  res.status(201).json({message:'Your public provider profile is live. Customers can contact your business directly.',provider:q.rows[0]});
 } catch(e) { console.error(e.message); res.status(500).json({error:'Could not publish your profile. Try again later.'}); }
});

app.use((_req,res)=>res.status(404).json({error:'Route not found.'}));

async function start() {
 await pool.query(`CREATE TABLE IF NOT EXISTS customer_enquiries (
  id BIGSERIAL PRIMARY KEY, model TEXT NOT NULL, issue TEXT NOT NULL, area TEXT NOT NULL,
  phone TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 )`);
 await pool.query(`CREATE TABLE IF NOT EXISTS provider_applications (
  id BIGSERIAL PRIMARY KEY, business TEXT NOT NULL, contact TEXT NOT NULL, area TEXT NOT NULL,
  phone TEXT NOT NULL, service TEXT NOT NULL, experience TEXT,
  status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 )`);
 await pool.query(`ALTER TABLE provider_applications ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`);
 app.listen(Number(process.env.PORT||4000),'0.0.0.0',()=>console.log('RepairDesk direct marketplace API ready'));
}
start().catch(error => { console.error('RepairDesk startup failed:',error.message); process.exit(1); });
