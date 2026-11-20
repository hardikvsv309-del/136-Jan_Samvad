import crypto from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import http from 'http';
import multer from 'multer';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from './src/db/index.ts';
import {
  auditLogs,
  complaints,
  complaintTimeline,
  emailNotifications,
  publicUpdates,
  users,
} from './src/db/schema.ts';
import { AuthRequest, requireAuth, requireAuthorizedTeam } from './src/middleware/auth.ts';
import { dispatchEmailNotification } from './src/services/mailer.ts';

dotenv.config();

const PORT = 3000;
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.bin';
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.webm', '.mov'].includes(ext)
      ? ext
      : '.bin';
    cb(null, `${crypto.randomUUID()}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15 MB per file
    files: 4,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIME.has(file.mimetype) || ALLOWED_VIDEO_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file format. Only JPG, PNG, WEBP images and MP4, WEBM, MOV videos are allowed.'));
    }
  },
});

// Simple IP-based submission rate limiter (max 6 complaints per 10 minutes per IP)
const submissionRateMap = new Map<string, number[]>();
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const recent = (submissionRateMap.get(ip) || []).filter((t) => now - t < windowMs);
  if (recent.length >= 6) {
    return false;
  }
  recent.push(now);
  submissionRateMap.set(ip, recent);
  return true;
}

// Deterministic ~120m privacy jitter so public map shows cluster/area without exact house coordinates
function applyPrivacyOffset(lat: number, lng: number, seedId: number): { lat: number; lng: number } {
  const angle = ((seedId * 137.5) % 360) * (Math.PI / 180);
  const offsetDeg = 0.0011;
  return {
    lat: Number((lat + Math.sin(angle) * offsetDeg).toFixed(5)),
    lng: Number((lng + Math.cos(angle) * offsetDeg).toFixed(5)),
  };
}

function escapeCsvCell(value: unknown): string {
  const str = String(value ?? '');
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function generateUniqueComplaintCode(): Promise<string> {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 5; attempt++) {
    const countRes = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(complaints);
    const seq = (countRes[0]?.count ?? 0) + 101 + attempt;
    const candidate = `WJS-${year}-${String(seq).padStart(4, '0')}`;
    const existing = await db
      .select({ id: complaints.id })
      .from(complaints)
      .where(eq(complaints.complaintCode, candidate))
      .limit(1);
    if (existing.length === 0) {
      return candidate;
    }
  }
  return `WJS-${year}-${crypto.randomInt(1000, 9999)}`;
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const broadcastEvent = (type: string, payload: Record<string, unknown>) => {
    const message = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'connected', payload: { channel: 'waghodia-live' } }));
  });

  // Safe uploaded media serving
  app.use(
    '/uploads',
    (_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      next();
    },
    express.static(UPLOADS_DIR)
  );

  // Health endpoint
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'waghodia-jan-samvad' });
  });

  // Upload photo/video attachments
  app.post('/api/upload', (req, res) => {
    upload.array('files', 4)(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'File upload failed' });
      }
      const files = (req.files as Express.Multer.File[]) || [];
      const result = files.map((file) => ({
        url: `/uploads/${file.filename}`,
        type: ALLOWED_VIDEO_MIME.has(file.mimetype) ? ('video' as const) : ('image' as const),
        name: file.originalname,
      }));
      res.json({ files: result });
    });
  });

  // PUBLIC: Aggregate statistics (No PII)
  app.get('/api/public/stats', async (_req, res) => {
    try {
      const rows = await db
        .select({
          status: complaints.status,
          category: complaints.category,
          village: complaints.village,
        })
        .from(complaints);

      let total = 0;
      let resolved = 0;
      let underFollowUp = 0;
      let pending = 0;
      const byCategory: Record<string, number> = {};
      const byVillage: Record<string, { total: number; resolved: number }> = {};

      for (const row of rows) {
        total++;
        if (row.status === 'resolved') resolved++;
        else if (row.status === 'verified' || row.status === 'in_progress') underFollowUp++;
        else pending++;

        byCategory[row.category] = (byCategory[row.category] || 0) + 1;
        if (!byVillage[row.village]) {
          byVillage[row.village] = { total: 0, resolved: 0 };
        }
        byVillage[row.village].total++;
        if (row.status === 'resolved') byVillage[row.village].resolved++;
      }

      res.json({
        total,
        resolved,
        underFollowUp,
        pending,
        resolutionRate: total > 0 ? Math.round((resolved / total) * 100) : 0,
        byCategory,
        byVillage,
      });
    } catch (error) {
      console.error('Failed to fetch public stats:', error);
      res.status(500).json({ error: 'Unable to load public statistics.' });
    }
  });

  // PUBLIC: Sanitized issue locations for map (No PII, no exact street address, ~120m offset)
  app.get('/api/public/map-issues', async (req, res) => {
    try {
      const { village, category, status } = req.query;
      const filters = [];
      if (typeof village === 'string' && village && village !== 'all') {
        filters.push(eq(complaints.village, village));
      }
      if (typeof category === 'string' && category && category !== 'all') {
        filters.push(eq(complaints.category, category));
      }
      if (typeof status === 'string' && status && status !== 'all') {
        filters.push(eq(complaints.status, status));
      }

      const rows = await db
        .select({
          id: complaints.id,
          complaintCode: complaints.complaintCode,
          village: complaints.village,
          category: complaints.category,
          title: complaints.title,
          status: complaints.status,
          latitude: complaints.latitude,
          longitude: complaints.longitude,
          createdAt: complaints.createdAt,
        })
        .from(complaints)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(complaints.createdAt))
        .limit(200);

      const sanitized = rows.map((row) => {
        const approx = applyPrivacyOffset(row.latitude, row.longitude, row.id);
        return {
          id: row.id,
          complaintCode: row.complaintCode,
          village: row.village,
          category: row.category,
          title: row.title,
          status: row.status,
          latitude: approx.lat,
          longitude: approx.lng,
          createdAt: row.createdAt,
        };
      });

      res.json({ issues: sanitized });
    } catch (error) {
      console.error('Failed to load map issues:', error);
      res.status(500).json({ error: 'Unable to load map issues.' });
    }
  });

  // PUBLIC: "Our Work" Transparency Showcase
  app.get('/api/public/work', async (_req, res) => {
    try {
      const rows = await db
        .select({
          id: complaints.id,
          complaintCode: complaints.complaintCode,
          village: complaints.village,
          category: complaints.category,
          title: complaints.title,
          description: complaints.description,
          actionTaken: complaints.actionTaken,
          resultSummary: complaints.resultSummary,
          beforePhotos: complaints.beforePhotos,
          afterPhotos: complaints.afterPhotos,
          createdAt: complaints.createdAt,
          resolvedAt: complaints.resolvedAt,
        })
        .from(complaints)
        .where(and(eq(complaints.status, 'resolved'), eq(complaints.isPublicShowcase, true)))
        .orderBy(desc(complaints.resolvedAt), desc(complaints.updatedAt));

      res.json({ works: rows });
    } catch (error) {
      console.error('Failed to load public work showcase:', error);
      res.status(500).json({ error: 'Unable to load public work records.' });
    }
  });

  // PUBLIC: Latest Constituency Updates
  app.get('/api/public/updates', async (_req, res) => {
    try {
      const rows = await db
        .select()
        .from(publicUpdates)
        .orderBy(desc(publicUpdates.publishedAt))
        .limit(12);
      res.json({ updates: rows });
    } catch (error) {
      console.error('Failed to load public updates:', error);
      res.status(500).json({ error: 'Unable to load latest updates.' });
    }
  });

  // PUBLIC: Track Complaint by unique ID (Sanitized - NO phone, email, citizen name, or internal notes)
  app.get('/api/complaints/track/:code', async (req, res) => {
    try {
      const code = req.params.code.trim().toUpperCase();
      if (!code || code.length < 5) {
        return res.status(400).json({ error: 'Invalid Complaint ID format.' });
      }

      const found = await db
        .select({
          id: complaints.id,
          complaintCode: complaints.complaintCode,
          village: complaints.village,
          category: complaints.category,
          title: complaints.title,
          description: complaints.description,
          status: complaints.status,
          priority: complaints.priority,
          locationLabel: complaints.locationLabel,
          actionTaken: complaints.actionTaken,
          resultSummary: complaints.resultSummary,
          beforePhotos: complaints.beforePhotos,
          afterPhotos: complaints.afterPhotos,
          createdAt: complaints.createdAt,
          updatedAt: complaints.updatedAt,
          resolvedAt: complaints.resolvedAt,
        })
        .from(complaints)
        .where(eq(complaints.complaintCode, code))
        .limit(1);

      if (found.length === 0) {
        return res.status(404).json({ error: 'No complaint found with that ID.' });
      }

      const timeline = await db
        .select({
          id: complaintTimeline.id,
          status: complaintTimeline.status,
          publicNote: complaintTimeline.publicNote,
          actorName: complaintTimeline.actorName,
          createdAt: complaintTimeline.createdAt,
        })
        .from(complaintTimeline)
        .where(eq(complaintTimeline.complaintId, found[0].id))
        .orderBy(asc(complaintTimeline.createdAt));

      res.json({
        complaint: found[0],
        timeline,
      });
    } catch (error) {
      console.error('Failed to track complaint:', error);
      res.status(500).json({ error: 'Unable to retrieve complaint status.' });
    }
  });

  // PUBLIC: Submit Complaint
  app.post('/api/complaints', async (req, res) => {
    try {
      const clientIp = req.ip || 'unknown';
      if (!checkRateLimit(clientIp)) {
        return res.status(429).json({ error: 'Too many submissions. Please wait a few minutes.' });
      }

      const {
        citizenName,
        mobileNumber,
        citizenEmail,
        village,
        category,
        title,
        description,
        latitude,
        longitude,
        locationLabel,
        mediaUrls,
        consentAccepted,
        website, // Honeypot
      } = req.body;

      // Honeypot check
      if (website && String(website).trim().length > 0) {
        return res.status(400).json({ error: 'Invalid submission.' });
      }

      if (!consentAccepted) {
        return res.status(400).json({ error: 'Privacy consent is required to submit a complaint.' });
      }

      const cleanName = String(citizenName || '').trim();
      const cleanMobile = String(mobileNumber || '').replace(/\D/g, '');
      const cleanEmail = citizenEmail ? String(citizenEmail).trim() : '';
      const cleanVillage = String(village || '').trim();
      const cleanCategory = String(category || '').trim();
      const cleanDesc = String(description || '').trim();
      const cleanTitle = String(title || '').trim() || cleanDesc.slice(0, 72);

      if (cleanName.length < 2) {
        return res.status(400).json({ error: 'Please enter a valid full name.' });
      }
      if (!/^[6-9]\d{9}$/.test(cleanMobile)) {
        return res.status(400).json({ error: 'Please enter a valid 10-digit Indian mobile number.' });
      }
      if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
      }
      if (!cleanVillage || !cleanCategory || cleanDesc.length < 10) {
        return res.status(400).json({ error: 'Village, category, and detailed problem description (min 10 chars) are required.' });
      }

      const lat = Number(latitude);
      const lng = Number(longitude);
      const safeLat = Number.isFinite(lat) ? lat : 22.3039;
      const safeLng = Number.isFinite(lng) ? lng : 73.3935;

      // Duplicate submission protection (same mobile + category + description snippet within 15 min)
      const submissionHash = crypto
        .createHash('sha256')
        .update(`${cleanMobile}:${cleanVillage}:${cleanCategory}:${cleanDesc.slice(0, 80)}`)
        .digest('hex');

      const recentDuplicate = await db
        .select({ id: complaints.id, createdAt: complaints.createdAt })
        .from(complaints)
        .where(eq(complaints.submissionHash, submissionHash))
        .orderBy(desc(complaints.createdAt))
        .limit(1);

      if (
        recentDuplicate.length > 0 &&
        Date.now() - new Date(recentDuplicate[0].createdAt).getTime() < 15 * 60 * 1000
      ) {
        return res.status(409).json({
          error: 'A similar complaint was recently submitted. Please track your existing Complaint ID.',
        });
      }

      const complaintCode = await generateUniqueComplaintCode();
      const safeMedia = Array.isArray(mediaUrls) ? mediaUrls.slice(0, 4) : [];

      const inserted = await db
        .insert(complaints)
        .values({
          complaintCode,
          citizenName: cleanName,
          mobileNumber: cleanMobile,
          citizenEmail: cleanEmail || null,
          village: cleanVillage,
          category: cleanCategory,
          title: cleanTitle,
          description: cleanDesc,
          latitude: safeLat,
          longitude: safeLng,
          locationLabel: String(locationLabel || cleanVillage).trim(),
          mediaUrls: safeMedia,
          status: 'submitted',
          priority: 'normal',
          consentAccepted: true,
          submissionHash,
        })
        .returning();

      const created = inserted[0];

      await db.insert(complaintTimeline).values({
        complaintId: created.id,
        status: 'submitted',
        publicNote: 'Complaint registered on Waghodia Jan Samvad portal.',
        actorName: 'Citizen Portal',
      });

      if (cleanEmail) {
        await dispatchEmailNotification({
          complaintId: created.id,
          complaintCode: created.complaintCode,
          recipientEmail: cleanEmail,
          subject: `[Waghodia Jan Samvad] Complaint Registered: ${created.complaintCode}`,
          bodyText: `Namaste ${cleanName},\n\nYour complaint (${created.complaintCode}) regarding ${cleanCategory} in ${cleanVillage} has been registered.\n\nTrack live status anytime using ID: ${created.complaintCode}.\n\n— Waghodia Jan Samvad Team`,
        });
      }

      const approx = applyPrivacyOffset(created.latitude, created.longitude, created.id);
      broadcastEvent('complaint:created', {
        id: created.id,
        complaintCode: created.complaintCode,
        village: created.village,
        category: created.category,
        title: created.title,
        status: created.status,
        latitude: approx.lat,
        longitude: approx.lng,
        createdAt: created.createdAt,
      });

      res.status(201).json({
        complaintCode: created.complaintCode,
        status: created.status,
        createdAt: created.createdAt,
      });
    } catch (error) {
      console.error('Failed to submit complaint:', error);
      res.status(500).json({ error: 'Unable to submit complaint. Please try again.' });
    }
  });

  // ADMIN: Current authenticated user profile & role
  app.get('/api/admin/me', requireAuth, (req: AuthRequest, res) => {
    res.json({ teamUser: req.teamUser });
  });

  // ADMIN: List & filter all complaints (Full details for authorized team)
  app.get('/api/admin/complaints', requireAuthorizedTeam, async (req: AuthRequest, res) => {
    try {
      const { village, category, status, q } = req.query;
      const conditions = [];

      if (typeof village === 'string' && village && village !== 'all') {
        conditions.push(eq(complaints.village, village));
      }
      if (typeof category === 'string' && category && category !== 'all') {
        conditions.push(eq(complaints.category, category));
      }
      if (typeof status === 'string' && status && status !== 'all') {
        conditions.push(eq(complaints.status, status));
      }
      if (typeof q === 'string' && q.trim()) {
        const pattern = `%${q.trim()}%`;
        conditions.push(
          or(
            ilike(complaints.complaintCode, pattern),
            ilike(complaints.citizenName, pattern),
            ilike(complaints.mobileNumber, pattern),
            ilike(complaints.title, pattern),
            ilike(complaints.village, pattern)
          )
        );
      }

      const rows = await db
        .select()
        .from(complaints)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(complaints.createdAt));

      res.json({ complaints: rows });
    } catch (error) {
      console.error('Admin fetch complaints error:', error);
      res.status(500).json({ error: 'Failed to load complaints.' });
    }
  });

  // ADMIN: Update complaint status, assignment, internal notes, action taken, before/after photos
  app.patch('/api/admin/complaints/:id', requireAuthorizedTeam, async (req: AuthRequest, res) => {
    try {
      const complaintId = Number(req.params.id);
      if (!Number.isInteger(complaintId)) {
        return res.status(400).json({ error: 'Invalid complaint ID.' });
      }

      const existingRows = await db
        .select()
        .from(complaints)
        .where(eq(complaints.id, complaintId))
        .limit(1);

      if (existingRows.length === 0) {
        return res.status(404).json({ error: 'Complaint not found.' });
      }
      const prev = existingRows[0];

      const {
        status,
        priority,
        assignedToId,
        assignedToName,
        internalNotes,
        actionTaken,
        resultSummary,
        beforePhotos,
        afterPhotos,
        isPublicShowcase,
        publicTimelineNote,
      } = req.body;

      const nextStatus = typeof status === 'string' ? status : prev.status;
      const validStatuses = ['submitted', 'verified', 'in_progress', 'resolved'];
      if (!validStatuses.includes(nextStatus)) {
        return res.status(400).json({ error: 'Invalid status value.' });
      }

      const resolvedAtValue =
        nextStatus === 'resolved'
          ? prev.resolvedAt || new Date()
          : prev.status === 'resolved'
            ? null
            : prev.resolvedAt;

      const updatedRows = await db
        .update(complaints)
        .set({
          status: nextStatus,
          priority: typeof priority === 'string' ? priority : prev.priority,
          assignedToId:
            assignedToId === null
              ? null
              : typeof assignedToId === 'number'
                ? assignedToId
                : prev.assignedToId,
          assignedToName:
            typeof assignedToName === 'string' ? assignedToName : prev.assignedToName,
          internalNotes:
            typeof internalNotes === 'string' ? internalNotes : prev.internalNotes,
          actionTaken: typeof actionTaken === 'string' ? actionTaken : prev.actionTaken,
          resultSummary:
            typeof resultSummary === 'string' ? resultSummary : prev.resultSummary,
          beforePhotos: Array.isArray(beforePhotos) ? beforePhotos : prev.beforePhotos,
          afterPhotos: Array.isArray(afterPhotos) ? afterPhotos : prev.afterPhotos,
          isPublicShowcase:
            typeof isPublicShowcase === 'boolean' ? isPublicShowcase : prev.isPublicShowcase,
          updatedAt: new Date(),
          resolvedAt: resolvedAtValue,
        })
        .where(eq(complaints.id, complaintId))
        .returning();

      const updated = updatedRows[0];
      const actorName = req.teamUser?.name || req.teamUser?.email || 'Admin Team';

      const customNote =
        typeof publicTimelineNote === 'string' ? publicTimelineNote.trim() : '';
      if (nextStatus !== prev.status || customNote) {
        const fallbackNote =
          nextStatus === 'verified'
            ? 'Complaint verified by constituency team.'
            : nextStatus === 'in_progress'
              ? updated.actionTaken || 'Follow-up and department action initiated.'
              : nextStatus === 'resolved'
                ? updated.resultSummary || 'Issue resolved and verified on site.'
                : 'Complaint status updated.';

        await db.insert(complaintTimeline).values({
          complaintId: updated.id,
          status: updated.status,
          publicNote: customNote || fallbackNote,
          actorName,
        });
      }

      await db.insert(auditLogs).values({
        actorEmail: req.teamUser?.email || 'unknown',
        actorName,
        action: nextStatus !== prev.status ? `STATUS_${nextStatus.toUpperCase()}` : 'COMPLAINT_UPDATED',
        targetCode: updated.complaintCode,
        details: `Updated ${updated.complaintCode} (status: ${prev.status} -> ${updated.status}, assigned: ${updated.assignedToName || 'Unassigned'})`,
      });

      if (updated.citizenEmail && nextStatus !== prev.status) {
        await dispatchEmailNotification({
          complaintId: updated.id,
          complaintCode: updated.complaintCode,
          recipientEmail: updated.citizenEmail,
          subject: `[Waghodia Jan Samvad] Update on ${updated.complaintCode}: ${updated.status.toUpperCase()}`,
          bodyText: `Namaste ${updated.citizenName},\n\nThe status of your complaint (${updated.complaintCode}) has been updated to: ${updated.status}.\n\n${customNote || updated.actionTaken || updated.resultSummary || ''}\n\n— Waghodia Jan Samvad Team`,
        });
      }

      const timeline = await db
        .select({
          id: complaintTimeline.id,
          status: complaintTimeline.status,
          publicNote: complaintTimeline.publicNote,
          actorName: complaintTimeline.actorName,
          createdAt: complaintTimeline.createdAt,
        })
        .from(complaintTimeline)
        .where(eq(complaintTimeline.complaintId, updated.id))
        .orderBy(asc(complaintTimeline.createdAt));

      broadcastEvent('complaint:updated', {
        complaintCode: updated.complaintCode,
        status: updated.status,
        actionTaken: updated.actionTaken,
        resultSummary: updated.resultSummary,
        updatedAt: updated.updatedAt,
        resolvedAt: updated.resolvedAt,
        timeline,
      });

      res.json({ complaint: updated, timeline });
    } catch (error) {
      console.error('Admin update complaint error:', error);
      res.status(500).json({ error: 'Failed to update complaint.' });
    }
  });

  // ADMIN: Publish public constituency update
  app.post('/api/admin/updates', requireAuthorizedTeam, async (req: AuthRequest, res) => {
    try {
      const { titleGu, titleHi, titleEn, summaryGu, summaryHi, summaryEn, category, village } =
        req.body;

      if (!titleEn || !summaryEn) {
        return res.status(400).json({ error: 'Title and summary are required.' });
      }

      const inserted = await db
        .insert(publicUpdates)
        .values({
          titleGu: titleGu || titleEn,
          titleHi: titleHi || titleEn,
          titleEn,
          summaryGu: summaryGu || summaryEn,
          summaryHi: summaryHi || summaryEn,
          summaryEn,
          category: category || 'roads',
          village: village || 'Vaghodia',
        })
        .returning();

      await db.insert(auditLogs).values({
        actorEmail: req.teamUser?.email || 'unknown',
        actorName: req.teamUser?.name || 'Admin',
        action: 'UPDATE_PUBLISHED',
        targetCode: null,
        details: `Published public update: ${titleEn}`,
      });

      broadcastEvent('update:created', { update: inserted[0] });
      res.status(201).json({ update: inserted[0] });
    } catch (error) {
      console.error('Failed to publish update:', error);
      res.status(500).json({ error: 'Failed to publish update.' });
    }
  });

  // ADMIN: Analytics, Monthly/Quarterly Reports, Audit Logs & Email Notification Logs
  app.get('/api/admin/analytics', requireAuthorizedTeam, async (_req: AuthRequest, res) => {
    try {
      const allComplaints = await db.select().from(complaints);
      const recentAudit = await db
        .select()
        .from(auditLogs)
        .orderBy(desc(auditLogs.createdAt))
        .limit(40);
      const recentEmails = await db
        .select()
        .from(emailNotifications)
        .orderBy(desc(emailNotifications.createdAt))
        .limit(30);

      const monthlyMap: Record<
        string,
        { period: string; total: number; resolved: number; pending: number }
      > = {};
      const quarterlyMap: Record<
        string,
        { period: string; total: number; resolved: number; pending: number }
      > = {};
      const categoryCounts: Record<string, number> = {};
      const villageCounts: Record<string, { total: number; resolved: number }> = {};

      let resolutionHoursSum = 0;
      let resolvedWithTimeCount = 0;

      for (const c of allComplaints) {
        const dt = new Date(c.createdAt);
        const monthKey = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
        const qNum = Math.floor(dt.getMonth() / 3) + 1;
        const quarterKey = `${dt.getFullYear()} Q${qNum}`;

        if (!monthlyMap[monthKey]) {
          monthlyMap[monthKey] = { period: monthKey, total: 0, resolved: 0, pending: 0 };
        }
        monthlyMap[monthKey].total++;
        if (c.status === 'resolved') monthlyMap[monthKey].resolved++;
        else monthlyMap[monthKey].pending++;

        if (!quarterlyMap[quarterKey]) {
          quarterlyMap[quarterKey] = { period: quarterKey, total: 0, resolved: 0, pending: 0 };
        }
        quarterlyMap[quarterKey].total++;
        if (c.status === 'resolved') quarterlyMap[quarterKey].resolved++;
        else quarterlyMap[quarterKey].pending++;

        categoryCounts[c.category] = (categoryCounts[c.category] || 0) + 1;
        if (!villageCounts[c.village]) {
          villageCounts[c.village] = { total: 0, resolved: 0 };
        }
        villageCounts[c.village].total++;
        if (c.status === 'resolved') villageCounts[c.village].resolved++;

        if (c.status === 'resolved' && c.resolvedAt) {
          const hrs =
            (new Date(c.resolvedAt).getTime() - new Date(c.createdAt).getTime()) /
            (1000 * 60 * 60);
          if (hrs >= 0) {
            resolutionHoursSum += hrs;
            resolvedWithTimeCount++;
          }
        }
      }

      const avgResolutionDays =
        resolvedWithTimeCount > 0
          ? Number((resolutionHoursSum / resolvedWithTimeCount / 24).toFixed(1))
          : 0;

      res.json({
        monthly: Object.values(monthlyMap).sort((a, b) => a.period.localeCompare(b.period)),
        quarterly: Object.values(quarterlyMap).sort((a, b) => a.period.localeCompare(b.period)),
        byCategory: categoryCounts,
        byVillage: villageCounts,
        avgResolutionDays,
        auditLogs: recentAudit,
        emailNotifications: recentEmails,
      });
    } catch (error) {
      console.error('Failed to compute analytics:', error);
      res.status(500).json({ error: 'Failed to load analytics.' });
    }
  });

  // ADMIN: Export CSV (Excel-compatible UTF-8 BOM)
  app.get('/api/admin/export-csv', requireAuthorizedTeam, async (req: AuthRequest, res) => {
    try {
      const { village, category, status } = req.query;
      const conditions = [];
      if (typeof village === 'string' && village && village !== 'all') {
        conditions.push(eq(complaints.village, village));
      }
      if (typeof category === 'string' && category && category !== 'all') {
        conditions.push(eq(complaints.category, category));
      }
      if (typeof status === 'string' && status && status !== 'all') {
        conditions.push(eq(complaints.status, status));
      }

      const rows = await db
        .select()
        .from(complaints)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(complaints.createdAt));

      const headers = [
        'Complaint ID',
        'Citizen Name',
        'Mobile Number',
        'Email',
        'Village',
        'Category',
        'Title',
        'Description',
        'Status',
        'Priority',
        'Assigned Officer',
        'Action Taken',
        'Result Summary',
        'Latitude',
        'Longitude',
        'Created At',
        'Resolved At',
      ];

      const lines = [
        headers.map(escapeCsvCell).join(','),
        ...rows.map((r) =>
          [
            r.complaintCode,
            r.citizenName,
            r.mobileNumber,
            r.citizenEmail || '',
            r.village,
            r.category,
            r.title,
            r.description,
            r.status,
            r.priority,
            r.assignedToName || '',
            r.actionTaken,
            r.resultSummary,
            r.latitude,
            r.longitude,
            new Date(r.createdAt).toISOString(),
            r.resolvedAt ? new Date(r.resolvedAt).toISOString() : '',
          ]
            .map(escapeCsvCell)
            .join(',')
        ),
      ];

      await db.insert(auditLogs).values({
        actorEmail: req.teamUser?.email || 'unknown',
        actorName: req.teamUser?.name || 'Admin',
        action: 'CSV_EXPORTED',
        targetCode: null,
        details: `Exported ${rows.length} complaint records to CSV.`,
      });

      const csvContent = '\uFEFF' + lines.join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="waghodia-complaints-${new Date().toISOString().slice(0, 10)}.csv"`
      );
      res.send(csvContent);
    } catch (error) {
      console.error('CSV export error:', error);
      res.status(500).json({ error: 'Failed to export CSV.' });
    }
  });

  // ADMIN: Full Database JSON Backup Snapshot
  app.get('/api/admin/backup', requireAuthorizedTeam, async (req: AuthRequest, res) => {
    try {
      const [allComplaints, allTimeline, allUpdates, allUsers, allAudits, allEmails] =
        await Promise.all([
          db.select().from(complaints),
          db.select().from(complaintTimeline),
          db.select().from(publicUpdates),
          db.select().from(users),
          db.select().from(auditLogs),
          db.select().from(emailNotifications),
        ]);

      await db.insert(auditLogs).values({
        actorEmail: req.teamUser?.email || 'unknown',
        actorName: req.teamUser?.name || 'Admin',
        action: 'BACKUP_EXPORTED',
        targetCode: null,
        details: `Downloaded full database backup (${allComplaints.length} complaints).`,
      });

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="waghodia-db-backup-${new Date().toISOString().slice(0, 10)}.json"`
      );
      res.send(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            platform: 'Waghodia Jan Samvad',
            tables: {
              complaints: allComplaints,
              complaintTimeline: allTimeline,
              publicUpdates: allUpdates,
              users: allUsers,
              auditLogs: allAudits,
              emailNotifications: allEmails,
            },
          },
          null,
          2
        )
      );
    } catch (error) {
      console.error('Backup export error:', error);
      res.status(500).json({ error: 'Failed to export backup.' });
    }
  });

  // ADMIN: Team Management
  app.get('/api/admin/team', requireAuthorizedTeam, async (_req: AuthRequest, res) => {
    try {
      const team = await db.select().from(users).orderBy(asc(users.id));
      res.json({ team });
    } catch (error) {
      console.error('Team list error:', error);
      res.status(500).json({ error: 'Failed to load team members.' });
    }
  });

  app.post('/api/admin/team', requireAuthorizedTeam, async (req: AuthRequest, res) => {
    try {
      if (req.teamUser?.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only super admins can add team members.' });
      }
      const { email, name, role, assignedArea } = req.body;
      const cleanEmail = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return res.status(400).json({ error: 'Valid email is required.' });
      }
      const allowedRoles = ['super_admin', 'coordinator', 'field_officer'];
      const cleanRole = allowedRoles.includes(role) ? role : 'field_officer';

      const inserted = await db
        .insert(users)
        .values({
          uid: `invited:${cleanEmail}`,
          email: cleanEmail,
          name: String(name || cleanEmail.split('@')[0]).trim(),
          role: cleanRole,
          assignedArea: String(assignedArea || 'All Villages').trim(),
          isActive: true,
        })
        .onConflictDoUpdate({
          target: users.email,
          set: {
            name: String(name || cleanEmail.split('@')[0]).trim(),
            role: cleanRole,
            assignedArea: String(assignedArea || 'All Villages').trim(),
            isActive: true,
          },
        })
        .returning();

      await db.insert(auditLogs).values({
        actorEmail: req.teamUser.email,
        actorName: req.teamUser.name,
        action: 'TEAM_MEMBER_ADDED',
        targetCode: cleanEmail,
        details: `Added/updated team member ${cleanEmail} as ${cleanRole}.`,
      });

      res.status(201).json({ member: inserted[0] });
    } catch (error) {
      console.error('Add team member error:', error);
      res.status(500).json({ error: 'Failed to add team member.' });
    }
  });

  app.patch('/api/admin/team/:id', requireAuthorizedTeam, async (req: AuthRequest, res) => {
    try {
      if (req.teamUser?.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only super admins can manage team roles.' });
      }
      const memberId = Number(req.params.id);
      const { role, assignedArea, isActive, name } = req.body;

      const updated = await db
        .update(users)
        .set({
          ...(typeof role === 'string' ? { role } : {}),
          ...(typeof assignedArea === 'string' ? { assignedArea } : {}),
          ...(typeof isActive === 'boolean' ? { isActive } : {}),
          ...(typeof name === 'string' ? { name } : {}),
        })
        .where(eq(users.id, memberId))
        .returning();

      if (updated.length === 0) {
        return res.status(404).json({ error: 'Team member not found.' });
      }

      await db.insert(auditLogs).values({
        actorEmail: req.teamUser.email,
        actorName: req.teamUser.name,
        action: 'TEAM_MEMBER_UPDATED',
        targetCode: updated[0].email,
        details: `Updated ${updated[0].email} (role: ${updated[0].role}, active: ${updated[0].isActive}).`,
      });

      res.json({ member: updated[0] });
    } catch (error) {
      console.error('Update team member error:', error);
      res.status(500).json({ error: 'Failed to update team member.' });
    }
  });

  // Vite dev middleware or static production files
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Waghodia Jan Samvad running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
