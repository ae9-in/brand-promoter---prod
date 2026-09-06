const express = require("express");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const prisma = require("../../config/db");
const { uploadFileToCloudinary } = require("../../config/cloudinary"); // legacy stub — kept for backward compat with old http:// records
const { isDbStorageKey, makeStorageKey, streamDbFile } = require("../../utils/dbStorage");


const { auth, requireRoles } = require("../../middleware/auth");
const { upload, memoryUpload } = require("../../middleware/upload");
const { asyncHandler, ApiError } = require("../../utils/errors");
const { validateFile } = require("../../utils/fileValidator");
const { logAudit } = require("../../utils/audit");
const { notifyAdmins, sendNotification } = require("../../utils/notifications");
const sse = require("../../utils/sse");
const { getCached } = require("../../utils/cache");
const inv = require("../../utils/cacheInvalidation");
const { upsertCompanyForOrg } = require("../companies/routes");
const { normalizePhoneNumber } = require("../../lib/phoneNormalization");
const { resolveCandidateByNumber } = require('../../lib/candidateResolver');

// Default company — used when none is supplied for backward-compat clients
const DEFAULT_COMPANY = 'Akshara Enterprises';

const isSafeKey = (key) => key && key !== '__proto__' && key !== 'constructor' && key !== 'prototype';

// SEC-003: SSRF guard — blocks RFC1918, loopback, link-local, and non-HTTP/S schemes.
// Applied before every server-side fetch() of a user-supplied URL.
const BLOCKED_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|::1|\[::1\]|fd[0-9a-f]{2}:)/i;
function isSafeProxyUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (BLOCKED_HOST_RE.test(parsed.hostname)) return false;
    return true;
  } catch { return false; }
}

const router = express.Router();

router.use(auth);

// Helper middleware to parse body for HTTP QUERY requests if the standard body-parser skipped it
const parseQueryBody = (req, res, next) => {
  if (req.method === 'QUERY' && (!req.body || Object.keys(req.body).length === 0)) {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        if (data) {
          req.body = JSON.parse(data);
        } else {
          req.body = {};
        }
        next();
      } catch (err) {
        res.status(400).json({ success: false, error: 'Invalid JSON body for QUERY request' });
      }
    });
  } else {
    next();
  }
};

const candidateSearchHandler = async (req, res) => {
  const q = (req.body.q || '').trim();
  const filters = req.body.filters || {};
  const limit = Math.min(250, Math.max(1, Number.parseInt(req.body.limit, 10) || 24));
  const cursor = req.body.cursor?.trim();
  const orgId = req.user.organizationId || "defaultOrg";

  const andConditions = [
    { organizationId: orgId },
    { isDeleted: false }
  ];

  if (filters.status && filters.status !== 'All') {
    const appSyncedStatuses = new Set(["JOINED", "OFFER_SENT", "REJECTED"]);
    if (appSyncedStatuses.has(filters.status)) {
      andConditions.push({
        OR: [
          { status: filters.status },
          { applications: { some: { status: filters.status, isDeleted: false } } },
        ],
      });
    } else {
      andConditions.push({ status: filters.status });
    }
  }
  if (filters.category && filters.category !== 'All') {
    andConditions.push({ category: filters.category });
  }
  if (filters.company && filters.company !== 'All') {
    andConditions.push({ company: filters.company });
  }

  if (q) {
    andConditions.push({
      OR: [
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } }
      ]
    });
  }

  if (cursor) {
    const parts = cursor.split('_');
    if (parts.length === 2) {
      const [timeStr, cursorId] = parts;
      const cursorTime = new Date(parseInt(timeStr, 10));
      andConditions.push({
        OR: [
          { updatedAt: { lt: cursorTime } },
          { updatedAt: cursorTime, id: { lt: cursorId } }
        ]
      });
    }
  }

  const where = { AND: andConditions };

  const queryOptions = {
    where,
    take: limit + 1,
    orderBy: [
      { updatedAt: 'desc' },
      { id: 'desc' }
    ],
    select: {
      id: true,
      fullName: true,
      preferredRole: true,
      location: true,
      area: true,
      source: true,
      email: true,
      phone: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      offerDecision: true,
      doj: true,
      company: true,
      resumeFile: { select: { storageKey: true } },
      profilePhotoFile: { select: { storageKey: true } },
      applications: {
        where: { isDeleted: false },
        select: {
          id: true,
          status: true,
          joiningDate: true,
          createdAt: true,
          updatedAt: true,
          job: { select: { id: true, title: true } }
        }
      }
    }
  };

  const [total, items] = await Promise.all([
    prisma.candidate.count({ where }),
    prisma.candidate.findMany(queryOptions)
  ]);

  const hasMore = items.length > limit;
  if (hasMore) {
    items.pop();
  }

  const nextCursor = hasMore 
    ? `${items[items.length - 1].updatedAt.getTime()}_${items[items.length - 1].id}` 
    : null;

  res.json({
    success: true,
    data: items,
    rows: items,
    nextCursor,
    hasMore,
    pagination: {
      total,
      limit,
      hasMore
    }
  });
};

// Candidate search route with QUERY and POST support
router.all('/search', parseQueryBody, requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"), asyncHandler(async (req, res) => {
  if (req.method === 'QUERY' || req.method === 'POST') {
    return await candidateSearchHandler(req, res);
  }
  res.status(405).set('Allow', 'QUERY, POST').end();
}));

// GET Custom field definitions
router.get(
  "/custom-fields/definitions",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const definitions = await prisma.customFieldDefinition.findMany();
    res.json({ success: true, data: definitions });
  })
);

// Normalize fields for import
function normalizeFieldKey(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeFieldValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch (_) {
    return "";
  }
}

function getFieldVal(raw, possibleNames) {
  if (!raw || typeof raw !== 'object') return undefined;
  const keys = Object.keys(raw);
  const normalizedNames = possibleNames.map(n => n.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const foundKey = keys.find(k => {
    const normalizedK = k.toLowerCase().replace(/[^a-z0-9]/g, '');
    return normalizedNames.includes(normalizedK);
  });
  return foundKey ? raw[foundKey] : undefined;
}

// POST Bulk candidate upload (from XLSX)
router.post(
  "/bulk-upload",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  (req, res, next) => {
    req.uploadFolder = "candidate-bulk";
    next();
  },
  memoryUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new ApiError(400, "Excel file is required (field: file)");
    }

    validateFile(req.file, 'bulkData');

    let allRows = [];
    // SEC: Harden XLSX parsing — disable formulas (prevents ReDoS + prototype pollution CVEs)
    const workbook = XLSX.read(req.file.buffer, { type: "buffer", raw: false, cellFormula: false, bookVBA: false, bookFiles: false, defval: '' });
    for (const sheetName of workbook.SheetNames) {
      if (!isSafeKey(sheetName)) continue;
      const sheet = workbook.Sheets[sheetName];
      const sheetRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      sheetRows.forEach((row, idx) => {
        allRows.push({
          ...row,
          _sheetName: sheetName,
          _rowIndex: idx + 2
        });
      });
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];
    const orgId = req.user.organizationId || "defaultOrg";

    for (let i = 0; i < allRows.length; i += 1) {
      const raw = allRows[Number(i)];
      const rawFullName = getFieldVal(raw, ['fullName', 'full name', 'name']);
      const fullName = rawFullName ? String(rawFullName).trim() : "";
      const rawEmail = getFieldVal(raw, ['email', 'email address', 'emailid', 'e-mail']);
      const email = rawEmail ? String(rawEmail).trim().toLowerCase() : null;
      const rawPhone = getFieldVal(raw, ['phone', 'phone number', 'contact', 'mobile']);
      const phone = rawPhone ? String(rawPhone).trim() : null;
      const sheetInfo = `[Sheet: ${raw._sheetName}, Row ${raw._rowIndex}]`;

      if (!fullName || !phone) {
        skipped += 1;
        errors.push(`${sheetInfo}: fullName and phone are required`);
        continue;
      }

      const { normalizePhoneForDedup } = require("../../lib/phoneNormalization");
      const phoneNormalized = normalizePhoneForDedup(phone) || phone.replace(/\D/g, "") || null;

      const rawCompany = getFieldVal(raw, ['currentCompany', 'current company', 'company']);
      const currentCompany = rawCompany ? String(rawCompany).trim() : null;

      const rawExp = getFieldVal(raw, ['totalExperienceYears', 'experienceYears', 'experience years', 'experience', 'total experience']);
      const totalExperienceYears = rawExp ? parseFloat(rawExp) : null;

      const rawSource = getFieldVal(raw, ['source', 'candidateSource', 'candidate source', 'candidate_source']);
      const source = rawSource ? String(rawSource).trim() : null;

      const rawRole = getFieldVal(raw, ['role', 'preferredRole', 'preferred role', 'job role']);
      const preferredRole = rawRole ? String(rawRole).trim() : null;

      const payload = {
        fullName,
        email: email || "N/A",
        phone,
        phoneNormalized,
        currentCompany,
        company: currentCompany,
        preferredRole,
        totalExperienceYears,
        source,
        status: "ACTIVE",
        organizationId: orgId,
        isDeleted: false,
        updatedAt: new Date(),
      };

      try {
        const existing = await prisma.candidate.findFirst({
          where: {
            organizationId: orgId,
            isDeleted: false,
            OR: [
              ...(phoneNormalized
                ? [
                    { phoneNormalized },
                    { phoneNormalized: { endsWith: phoneNormalized } },
                    { phone },
                  ]
                : [{ phone }]),
              ...(email ? [{ email: { equals: email, mode: "insensitive" } }] : []),
            ],
          },
          select: { id: true },
        });

        if (existing) {
          await prisma.candidate.update({
            where: { id: existing.id },
            data: payload,
          });
          updated += 1;
        } else {
          await prisma.candidate.create({
            data: {
              ...payload,
              createdById: req.user.id,
              createdAt: new Date(),
            },
          });
          inserted += 1;
        }
      } catch (err) {
        skipped += 1;
        errors.push(`${sheetInfo}: ${err.message}`);
      }
    }

    if (inserted + updated > 0) {
      await inv.candidateList(orgId);
      sse.broadcastToOrg(orgId, "CANDIDATE_CREATED", { count: inserted + updated });
    }

    await logAudit({
      actorUserId: req.user.id,
      action: "BULK_UPLOAD_CANDIDATES",
      entityType: "CANDIDATE",
      newData: { totalRows: allRows.length, inserted, updated, skipped },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    res.status(201).json({
      success: true,
      data: { totalRows: allRows.length, inserted, updated, skipped, errors },
    });
  }),
);

const importJobs = new Map();

// POST Bulk Import Wizard (candidates + applications creation)
router.post(
  "/bulk-import",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const { rows, jobId } = req.body;
    if (!rows || !Array.isArray(rows) || !jobId) {
      throw new ApiError(400, "rows (array) and jobId are required");
    }

    const importJobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    importJobs.set(importJobId, { status: 'processing', progress: 0, total: rows.length, inserted: 0, skipped: 0 });

    const orgId = req.user.organizationId || "defaultOrg";
    const userId = req.user.id;

    // Run background task
    setTimeout(async () => {
      let inserted = 0;
      let skipped = 0;
      
      try {
        for (let i = 0; i < rows.length; i++) {
          const raw = rows[Number(i)];
          const rawFullName = getFieldVal(raw, ['fullName', 'full name', 'name']);
          const fullName = rawFullName ? String(rawFullName).trim() : "";
          const rawEmail = getFieldVal(raw, ['email', 'email address', 'emailid']);
          const email = rawEmail ? String(rawEmail).trim().toLowerCase() : null;
          const rawPhone = getFieldVal(raw, ['phone', 'phone number', 'contact', 'mobile']);
          const phone = rawPhone ? String(rawPhone).trim() : null;
          const rawResume = getFieldVal(raw, ['resumeLink', 'resume link', 'resume', 'resume_link']);
          const resumeLink = rawResume ? String(rawResume).trim() : null;

          if (!fullName || !phone || !resumeLink) {
            skipped++;
            continue;
          }

          const { normalizeResumeLink } = require("../../lib/resumeLinkNormalizer");
          const normalizedResume = normalizeResumeLink(resumeLink);
          if (!normalizedResume) {
            skipped++;
            continue;
          }

          // Check for existing phone number
          const existing = await prisma.candidate.findFirst({
            where: { phone, organizationId: orgId, isDeleted: false }
          });
          if (existing) {
            skipped++;
            continue;
          }

          const rawLocation = getFieldVal(raw, ['location', 'place', 'city']);
          const location = rawLocation ? String(rawLocation).trim() : null;

          const rawArea = getFieldVal(raw, ['area', 'region']);
          const area = rawArea ? String(rawArea).trim() : null;

          const rawCourse = getFieldVal(raw, ['course', 'graduation course', 'degree']);
          const course = rawCourse ? String(rawCourse).trim() : null;

          const rawGradYear = getFieldVal(raw, ['graduationYear', 'graduation year', 'grad year']);
          const graduationYear = rawGradYear ? String(rawGradYear).trim() : null;

          const rawPreferredRole = getFieldVal(raw, ['preferredRole', 'preferred role', 'role']);
          const preferredRole = rawPreferredRole ? String(rawPreferredRole).trim() : null;

          const rawSource = getFieldVal(raw, ['source', 'candidateSource', 'candidate source', 'candidate_source']);
          const source = rawSource ? String(rawSource).trim() : "Bulk Import Wizard";

          const candidate = await prisma.candidate.create({
            data: {
              fullName,
              email: email || "N/A",
              phone,
              location,
              area,
              course,
              graduationYear,
              preferredRole,
              source,
              resumeLinkOriginal: normalizedResume.originalUrl,
              resumeLinkDownload: normalizedResume.downloadUrl,
              resumeLinkProvider: normalizedResume.provider,
              createdById: userId,
              status: "ACTIVE",
              organizationId: orgId,
              isDeleted: false
            }
          });

          await prisma.application.create({
            data: {
              candidateId: candidate.id,
              jobId: jobId,
              status: "IN_PIPELINE",
              organizationId: orgId,
              isDeleted: false
            }
          });

          inserted++;
          importJobs.set(importJobId, { status: 'processing', progress: Math.floor(((i + 1) / rows.length) * 100), total: rows.length, inserted, skipped });
        }

        importJobs.set(importJobId, { status: 'completed', progress: 100, total: rows.length, inserted, skipped });
        
        await inv.candidateList(orgId);
        sse.broadcastToOrg(orgId, 'CANDIDATE_CREATED', { count: inserted });

        await prisma.notification.create({
          data: {
            userId: userId,
            title: "Bulk Import Complete",
            message: `Imported ${inserted} candidates.`,
            type: "INFO",
          }
        });

      } catch (err) {
        importJobs.set(importJobId, { status: 'failed', error: err.message });
      }
    }, 0);

    res.status(202).json({ success: true, importJobId });
  })
);

router.get(
  "/import-jobs/:importJobId/status",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const job = importJobs.get(req.params.importJobId);
    if (!job) throw new ApiError(404, "Import job not found");
    res.json({ success: true, data: job });
  })
);

// POST Create single candidate
router.post(
  "/",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const data = req.body;
    if (!data.fullName) throw new ApiError(400, "fullName is required");
    if (!data.phone) throw new ApiError(400, "Phone number is required");

    const isDrive = Boolean(data.driveId || data.college);
    const isJoined = String(data.status || '').toUpperCase() === 'JOINED';
    const hasResume = Boolean(data.resumeFileId || data.resumeLinkOriginal || data.resumeLinkDownload);
    if (!isDrive && !isJoined && !hasResume) {
      throw new ApiError(400, "Resume is required for candidate creation.");
    }

    const orgId = req.user.organizationId || "defaultOrg";

    // Deduplication by phone
    const existingPhone = await prisma.candidate.findFirst({
      where: { phone: data.phone.trim(), organizationId: orgId, isDeleted: false }
    });
    if (existingPhone) throw new ApiError(409, "A candidate with this phone number already exists.");

    // Resolve company — default to org primary if not provided
    const resolvedCompany = (data.company || '').trim() || DEFAULT_COMPANY;

    const phoneNormalized = data.phone ? normalizePhoneNumber(data.phone) : null;
    const allowedCreateStatuses = new Set(["ACTIVE", "OFFER_SENT", "JOINED", "REJECTED"]);
    const createStatus = allowedCreateStatuses.has(String(data.status || "").toUpperCase())
      ? String(data.status).toUpperCase()
      : "ACTIVE";

    const candidateData = {
      fullName: data.fullName,
      email: data.email || "N/A",
      phone: data.phone,
      phoneNormalized,
      resumeFileId: data.resumeFileId || null,
      resumeLinkOriginal: data.resumeLinkOriginal || null,
      resumeLinkDownload: data.resumeLinkDownload || null,
      resumeLinkProvider: data.resumeLinkProvider || null,
      currentCompany: data.currentCompany || null,
      totalExperienceYears: data.totalExperienceYears ? parseFloat(data.totalExperienceYears) : null,
      location: data.location || null,
      area: data.area || null,
      course: data.course || null,
      graduationYear: data.graduationYear ? String(data.graduationYear) : null,
      preferredRole: data.preferredRole || null,
      source: data.source || null,
      jobTitle: data.jobTitle || null,
      category: data.category || "External",
      customFields: data.customFields || null,
      college: data.college || null,
      company: resolvedCompany,           // ── NEW field ──
      createdById: req.user.id,
      status: createStatus,
      organizationId: orgId,
      isDeleted: false
    };

    const candidate = await prisma.candidate.create({
      data: candidateData
    });

    const driveId = data.driveId || null;
    if (driveId) {
      const driveDup = await prisma.collegeDriveCandidate.findFirst({
        where: { driveId, candidateId: candidate.id }
      });
      if (!driveDup) {
        await prisma.collegeDriveCandidate.create({
          data: {
            driveId,
            candidateId: candidate.id,
            fullName: candidate.fullName,
            email: candidate.email || null,
            phone: candidate.phone || '',
            status: "ADDED"
          }
        });
      }
      await inv.drive(orgId, driveId);
    }

    // Invalidate cache before returning response to avoid race conditions
    await inv.candidate(orgId, candidate.id);

    // ── Respond IMMEDIATELY — client never waits for side effects ──
    res.status(201).json({ success: true, data: candidate });

    // ── Side effects run AFTER response is on the wire ──
    setImmediate(async () => {
      // Ensure company name exists in lookup table (non-blocking)
      upsertCompanyForOrg(orgId, resolvedCompany).catch(err =>
        console.error('[Candidates:Create] company upsert failed:', err.message)
      );
      try {
        await logAudit({
          actorUserId: req.user.id,
          action: "CREATE_CANDIDATE",
          entityType: "CANDIDATE",
          entityId: candidate.id,
          newData: candidate,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        });
      } catch (auditErr) {
        console.error('[Candidates:Create] Audit log failed (non-fatal):', auditErr.message);
      }
      sse.broadcastToOrg(orgId, 'CANDIDATE_CREATED', {
        candidateId: candidate.id,
        candidate,
        createdBy: req.user.id,
        createdByName: req.user.fullName || req.user.email,
      });
      if (driveId) {
        sse.broadcastToOrg(orgId, 'DRIVE_CANDIDATES_ADDED', {
          driveId,
          count: 1,
          collegeName: candidate.fullName,
          addedBy: req.user.id,
          addedByName: req.user.fullName || req.user.email,
        });
      }
    });
  }),
);

// POST Create single candidate with resume upload
router.post(
  "/with-resume-upload",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  (req, res, next) => {
    req.uploadFolder = "candidate-resumes";
    next();
  },
  upload.single("resume"),
  asyncHandler(async (req, res) => {
    const { fullName, email, phone, category, driveId, college } = req.body;

    if (!fullName) throw new ApiError(400, "fullName is required");
    if (!phone) throw new ApiError(400, "Phone number is required");

    const isDrive = Boolean(driveId || college);
    const isJoined = String(req.body.status || '').toUpperCase() === 'JOINED';
    if (!isDrive && !isJoined && !req.file) {
      throw new ApiError(400, "Resume file is required for candidate creation.");
    }

    const orgId = req.user.organizationId || "defaultOrg";

    const existingPhone = await prisma.candidate.findFirst({
      where: { phone: phone.trim(), organizationId: orgId, isDeleted: false }
    });
    if (existingPhone) throw new ApiError(409, "A candidate with this phone number already exists.");

    let resumeFileId = null;
    if (req.file) {
      validateFile(req.file, 'candidate');
      // Store resume directly in DB — no Cloudinary, no local disk
      const tempFileMeta = await prisma.fileMeta.create({
        data: {
          storageKey: 'db://pending',
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          sizeBytes: req.file.size,
          fileData: req.file.buffer,
          uploadedById: req.user.id,
        }
      });
      await prisma.fileMeta.update({
        where: { id: tempFileMeta.id },
        data: { storageKey: makeStorageKey(tempFileMeta.id) }
      });
      resumeFileId = tempFileMeta.id;
    }

    const resolvedCompanyResume = (req.body.company || '').trim() || DEFAULT_COMPANY;
    const allowedCreateStatuses = new Set(["ACTIVE", "OFFER_SENT", "JOINED", "REJECTED"]);
    const createStatus = allowedCreateStatuses.has(String(req.body.status || "").toUpperCase())
      ? String(req.body.status).toUpperCase()
      : "ACTIVE";
    const phoneNormalized = phone ? normalizePhoneNumber(phone) : null;

    const candidateData = {
      fullName,
      email: email || "N/A",
      phone,
      phoneNormalized,
      resumeFileId,
      currentCompany: req.body.currentCompany || null,
      totalExperienceYears: req.body.totalExperienceYears ? parseFloat(req.body.totalExperienceYears) : null,
      location: req.body.location || null,
      area: req.body.area || null,
      course: req.body.course || null,
      graduationYear: req.body.graduationYear ? String(req.body.graduationYear) : null,
      preferredRole: req.body.preferredRole || null,
      college: college || req.body.college || null,
      source: req.body.source || null,
      jobTitle: req.body.jobTitle || null,
      category: category || "External",
      customFields: req.body.customFields ? (typeof req.body.customFields === 'string' ? JSON.parse(req.body.customFields) : req.body.customFields) : null,
      company: resolvedCompanyResume,     // ── NEW field ──
      createdById: req.user.id,
      status: createStatus,
      organizationId: orgId,
      isDeleted: false
    };

    const candidate = await prisma.candidate.create({
      data: candidateData,
      include: {
        resumeFile: {
          select: {
            id: true,
            storageKey: true,
            originalName: true,
            mimeType: true,
            sizeBytes: true,
            createdAt: true,
          }
        }
      }
    });

    if (driveId) {
      const driveDup = await prisma.collegeDriveCandidate.findFirst({
        where: { driveId, candidateId: candidate.id }
      });
      if (!driveDup) {
        await prisma.collegeDriveCandidate.create({
          data: {
            driveId,
            candidateId: candidate.id,
            fullName: candidate.fullName,
            email: candidate.email || null,
            phone: candidate.phone || '',
            status: "ADDED"
          }
        });
      }
      await inv.drive(orgId, driveId);
    }

    // Invalidate cache before returning response to avoid race conditions
    await inv.candidate(orgId, candidate.id);

    // ── Respond IMMEDIATELY — client never waits for side effects ──
    res.status(201).json({ 
      success: true, 
      data: candidate 
    });

    // ── Side effects run AFTER response is on the wire ──
    setImmediate(async () => {
      // Ensure company exists in lookup (non-blocking)
      upsertCompanyForOrg(orgId, resolvedCompanyResume).catch(err =>
        console.error('[Candidates:CreateResume] company upsert failed:', err.message)
      );
      try {
        await logAudit({
          actorUserId: req.user.id,
          action: "CREATE_CANDIDATE_WITH_RESUME",
          entityType: "CANDIDATE",
          entityId: candidate.id,
          newData: candidate,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        });
      } catch (auditErr) {
        console.error('[Candidates:CreateResume] Audit log failed (non-fatal):', auditErr.message);
      }
      sse.broadcastToOrg(orgId, 'CANDIDATE_CREATED', {
        candidateId: candidate.id,
        candidate,
        createdBy: req.user.id,
        createdByName: req.user.fullName || req.user.email,
      });
      if (driveId) {
        sse.broadcastToOrg(orgId, 'DRIVE_CANDIDATES_ADDED', {
          driveId,
          count: 1,
          collegeName: candidate.fullName,
          addedBy: req.user.id,
          addedByName: req.user.fullName || req.user.email,
        });
      }
    });
  })
);

// GET List candidates (with filter, search, cursor pagination)
router.get(
  "/",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const limit = Math.min(250, Math.max(1, Number.parseInt(req.query.limit, 10) || 24));
    const cursor = req.query.cursor?.trim(); 
    const search = req.query.search?.trim();
    const category = req.query.category?.trim();
    const status = req.query.status?.trim();
    const company = req.query.company?.trim();  // ── NEW filter ──
    const assignedToMe = req.query.assignedToMe === 'true';
    const orgId = req.user.organizationId || "defaultOrg";

    const cacheKeyStr = `candidates:list:${orgId}:${cursor || 'start'}:${limit}:${search || ''}:${category || ''}:${status || ''}:${assignedToMe}:${company || ''}`;

    const fetchCandidatesFromDb = async () => {
      const andConditions = [
        { organizationId: orgId },
        { isDeleted: false }
      ];

      if (status) {
        // Sidebar views (JOINED / OFFER_SENT / REJECTED) may be set on the
        // candidate record OR only on a related application — match either.
        const appSyncedStatuses = new Set(["JOINED", "OFFER_SENT", "REJECTED"]);
        if (appSyncedStatuses.has(status)) {
          andConditions.push({
            OR: [
              { status },
              { applications: { some: { status, isDeleted: false } } },
            ],
          });
        } else {
          andConditions.push({ status });
        }
      }
      if (category) andConditions.push({ category });
      if (company) andConditions.push({ company });
      if (assignedToMe) andConditions.push({ mentorId: req.user.id });

      if (search) {
        andConditions.push({
          OR: [
            { fullName: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } }
          ]
        });
      }

      if (cursor) {
        const parts = cursor.split('_');
        if (parts.length === 2) {
          const [timeStr, cursorId] = parts;
          const cursorTime = new Date(parseInt(timeStr, 10));
          andConditions.push({
            OR: [
              { updatedAt: { lt: cursorTime } },
              { updatedAt: cursorTime, id: { lt: cursorId } }
            ]
          });
        }
      }

      const where = { AND: andConditions };

      const queryOptions = {
        where,
        take: limit + 1,
        orderBy: [
          { updatedAt: 'desc' },
          { id: 'desc' }
        ],
        select: {
          id: true,
          fullName: true,
          preferredRole: true,
          location: true,
          area: true,
          source: true,
          email: true,
          phone: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          offerDecision: true,
          doj: true,
          company: true,   // ── NEW field ──
          resumeFile: {
            select: {
              storageKey: true
            }
          },
          profilePhotoFile: {
            select: {
              storageKey: true
            }
          },
          applications: {
            where: { isDeleted: false },
            select: {
              id: true,
              status: true,
              joiningDate: true,
              createdAt: true,
              updatedAt: true,
              job: {
                select: {
                  id: true,
                  title: true
                }
              }
            }
          }
        }
      };

      // Fetch count and items in parallel to optimize latency by a full roundtrip
      const [total, items] = await Promise.all([
        prisma.candidate.count({ where }),
        prisma.candidate.findMany(queryOptions)
      ]);

      const hasMore = items.length > limit;
      if (hasMore) {
        items.pop();
      }

      const nextCursor = hasMore 
        ? `${items[items.length - 1].updatedAt.getTime()}_${items[items.length - 1].id}` 
        : null;

      return { items, nextCursor, hasMore, total };
    };

    let data;
    if (search) {
      data = await fetchCandidatesFromDb();
    } else {
      data = await getCached(cacheKeyStr, fetchCandidatesFromDb, 20000);
    }


    const pagination = {
      total: data.total || 0,
      limit,
      hasMore: data.hasMore
    };

    if (data.items && data.items.length > 30) {
      const { streamPaginatedJson } = require("../../utils/streamResponse");
      return streamPaginatedJson(res, data.items, { nextCursor: data.nextCursor, hasMore: data.hasMore, pagination, rows: data.items });
    }

    res.json({
      success: true,
      data: data.items,
      rows: data.items,
      nextCursor: data.nextCursor,
      hasMore: data.hasMore,
      pagination
    });
  })
);

// GET Candidate timeline history
router.get(
  "/:id/history",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const orgId = req.user.organizationId || "defaultOrg";

    const candidateCheck = await prisma.candidate.findUnique({
      where: { id },
      select: { organizationId: true }
    });
    if (!candidateCheck) throw new ApiError(404, "Candidate not found");
    if (candidateCheck.organizationId !== orgId) {
      throw new ApiError(403, "You do not have access to this candidate's data");
    }

    const cacheKey = `candidates:history:${id}`;

    const data = await getCached(cacheKey, async () => {
      const candidate = await prisma.candidate.findUnique({
        where: { id },
        include: {
          applications: {
            where: { isDeleted: false },
            include: {
              pipelineEvents: {
                include: {
                  fromStage: true,
                  toStage: true
                }
              },
              interviews: true
            }
          }
        }
      });

      if (!candidate) throw new ApiError(404, "Candidate not found");

      const timeline = [];
      
      candidate.applications.forEach(app => {
        timeline.push({
          id: `app_create_${app.id}`,
          type: "APPLICATION_CREATED",
          at: app.createdAt,
          applicationId: app.id,
        });

        app.pipelineEvents.forEach(evt => {
          timeline.push({
            id: evt.id,
            type: "PIPELINE_MOVED",
            at: evt.movedAt,
            ...evt
          });
        });

        app.interviews.forEach(intv => {
          timeline.push({
            id: intv.id,
            type: "INTERVIEW_SCHEDULED",
            at: intv.scheduledStart || intv.createdAt,
            ...intv
          });
        });
      });

      timeline.sort((a, b) => new Date(b.at) - new Date(a.at));

      return { candidate, applications: candidate.applications, timeline };
    }, 30000); // 30s cache

    res.json({ success: true, data });
  }),
);

// PATCH Update candidate
router.patch(
  "/:id",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const orgId = req.user.organizationId || "defaultOrg";

    const candidate = await prisma.candidate.findUnique({
      where: { id }
    });
    if (!candidate) throw new ApiError(404, "Candidate not found");
    if (candidate.organizationId !== orgId) {
      throw new ApiError(403, "You do not have access to this candidate's data");
    }

    if (data.phone) {
      const currentPhoneClean = (candidate.phone || "").replace(/\D/g, "");
      const newPhoneClean = data.phone.replace(/\D/g, "");
      if (currentPhoneClean !== newPhoneClean) {
        const existingPhone = await prisma.candidate.findFirst({
          where: { phone: data.phone.trim(), organizationId: orgId, isDeleted: false }
        });
        if (existingPhone && existingPhone.id !== id) {
          throw new ApiError(409, "A candidate with this phone number already exists.");
        }
      }
    }

    if (data.email === "" || data.email === null) {
      data.email = "N/A";
    }

    // Prepare fields for Prisma update
    const updateData = {};
    const allowedFields = [
      "fullName", "email", "phone", "currentCompany", "totalExperienceYears",
      "location", "area", "course", "graduationYear", "preferredRole",
      "source", "jobTitle", "category", "status", "currentStage", "mentorId",
      "assignedRecruiterId", "assignedRecruiterName", "customFields", "offerDecision", "doj",
      "company"  // ── NEW: client-specified hiring organization ──
    ];

    allowedFields.forEach(field => {
      if (data[field] !== undefined) {
        if (field === "totalExperienceYears") {
          updateData[field] = data[field] ? parseFloat(data[field]) : null;
        } else {
          updateData[field] = data[field];
        }
      }
    });

    const updatedCandidate = await prisma.candidate.update({
      where: { id },
      data: updateData
    });

    if (updateData.status === 'JOINED') {
      await prisma.application.updateMany({
        where: { candidateId: id, isDeleted: false },
        data: {
          status: 'JOINED',
          joiningDate: updateData.doj || updatedCandidate.doj || new Date()
        }
      });
      try {
        await inv.application(orgId, id);
      } catch (err) {
        console.error('[Candidates:Update] application cache invalidation failed:', err.message);
      }
    }

    await logAudit({
      actorUserId: req.user.id,
      action: "UPDATE_CANDIDATE",
      entityType: "CANDIDATE",
      entityId: id,
      newData: data,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    // Invalidate cache before returning response to avoid race conditions
    await inv.candidate(orgId, id);

    res.json({ success: true, data: updatedCandidate });

    setImmediate(async () => {
      // If company was changed, ensure it exists in lookup (non-blocking)
      if (data.company) {
        upsertCompanyForOrg(orgId, data.company.trim()).catch(err =>
          console.error('[Candidates:Update] company upsert failed:', err.message)
        );
      }
      sse.broadcastToOrg(orgId, 'CANDIDATE_UPDATED', {
        candidateId: id,
        changes: data,
        updatedBy: req.user.id,
        updatedByName: req.user.fullName || req.user.email,
      });
    });
  }),
);

// GET All candidate distinct categories
router.get(
  "/categories",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const orgId = req.user.organizationId || "defaultOrg";
    const categories = await prisma.candidate.findMany({
      where: {
        organizationId: orgId,
        isDeleted: false,
        category: { not: null }
      },
      select: {
        category: true
      },
      distinct: ['category']
    });
    
    const list = categories.map(c => c.category).filter(Boolean);
    res.json({ success: true, data: list });
  }),
);

// GET Candidate by ID
router.get(
  "/:id",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const orgId = req.user.organizationId || "defaultOrg";
    const candidate = await prisma.candidate.findUnique({
      where: { id },
      include: {
        resumeFile: {
          select: {
            id: true,
            storageKey: true,
            originalName: true,
            mimeType: true,
            sizeBytes: true,
            createdAt: true,
          }
        },
        profilePhotoFile: {
          select: {
            id: true,
            storageKey: true,
            originalName: true,
            mimeType: true,
            sizeBytes: true,
            createdAt: true,
          }
        }
      }
    });
    
    if (!candidate) throw new ApiError(404, "Candidate not found");
    if (candidate.organizationId !== orgId) {
      throw new ApiError(403, "You do not have access to this candidate's data");
    }
    res.json({ success: true, data: candidate });
  }),
);

// GET Download candidate resume
router.get(
  "/:id/resume/download",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const orgId = req.user.organizationId || "defaultOrg";
    const candidate = await prisma.candidate.findUnique({
      where: { id },
      include: {
        resumeFile: true
      }
    });

    if (!candidate) {
      throw new ApiError(404, "Candidate not found");
    }

    if (candidate.organizationId !== orgId) {
      throw new ApiError(403, "You do not have access to this candidate's data");
    }

    if (!candidate.resumeFile || !candidate.resumeFile.storageKey) {
      throw new ApiError(404, "Resume file not found for this candidate");
    }

    const { storageKey, originalName, mimeType, fileData } = candidate.resumeFile;
    const safeFileName = originalName || 'resume.pdf';

    // --- Priority 1: DB-stored binary (new uploads) ---
    if (isDbStorageKey(storageKey) || fileData) {
      if (!fileData || fileData.length === 0) {
        throw new ApiError(404, "Resume not found in database. It may have been stored externally and is no longer available.");
      }
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(safeFileName)}"`);
      res.setHeader("Content-Type", mimeType || "application/octet-stream");
      streamDbFile(fileData, res);
      return;
    }

    // --- Priority 2: Legacy remote URL (old Cloudinary or other http records) ---
    // Cloudinary is fully removed — attempt a plain fetch; redirect as last resort
    if (storageKey && (storageKey.startsWith('http://') || storageKey.startsWith('https://'))) {
      try {
        const response = await fetch(storageKey);
        if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
        const buf = Buffer.from(await response.arrayBuffer());
        res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(safeFileName)}"`);
        res.setHeader("Content-Type", mimeType || "application/octet-stream");
        res.send(buf);
      } catch (err) {
        console.error("[CandidateResume] Error fetching from remote URL:", err.message);
        res.redirect(storageKey);
      }
      return;
    }

    // --- Priority 3: Legacy local file (ephemeral disk — NOT available in production) ---
    // Files stored on local disk before the Aug 2026 storage migration are permanently lost.
    // Render wipes the ephemeral filesystem on every redeploy.
    // The DB record has been cleared by fix-broken-resume-records.js, so this branch
    // should only be reached in local dev. In production, route ends at Priority 1 or 2.
    if (storageKey && (storageKey.startsWith('/') || storageKey.startsWith('uploads/'))) {
      throw new ApiError(404,
        "Resume not available — this file was stored on the server's local disk before the " +
        "Aug 2026 storage migration and has since been permanently deleted by a server redeploy. " +
        "Please re-upload the resume for this candidate."
      );
    }

    throw new ApiError(400, "Invalid or unsupported storage key format.");
  }),
);



// POST Upload candidate resume after creation
router.post(
  "/:id/resume",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  upload.single("resume"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!req.file) throw new ApiError(400, "No resume file uploaded");

    const candidate = await prisma.candidate.findUnique({
      where: { id }
    });
    if (!candidate) throw new ApiError(404, "Candidate not found");
    const orgId = req.user.organizationId || "defaultOrg";
    if (candidate.organizationId !== orgId) {
      throw new ApiError(403, "You do not have access to this candidate's data");
    }

    // Store resume directly in DB — no Cloudinary, no local disk
    const tempFileMeta = await prisma.fileMeta.create({
      data: {
        storageKey: 'db://pending',
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        fileData: req.file.buffer,
        uploadedById: req.user.id
      }
    });
    await prisma.fileMeta.update({
      where: { id: tempFileMeta.id },
      data: { storageKey: makeStorageKey(tempFileMeta.id) }
    });
    
    await prisma.candidate.update({
      where: { id },
      data: {
        resumeFileId: tempFileMeta.id
      }
    });

    await inv.candidate(orgId, id);

    res.json({ success: true, data: { resumeFileId: tempFileMeta.id, storageKey: makeStorageKey(tempFileMeta.id) } });
  }),
);


// DELETE Soft delete candidate
router.delete(
  "/:id",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const orgId = req.user.organizationId || "defaultOrg";

    const candidate = await prisma.candidate.findUnique({
      where: { id }
    });
    if (!candidate) throw new ApiError(404, "Candidate not found");
    if (candidate.organizationId !== orgId) {
      throw new ApiError(403, "You do not have access to this candidate's data");
    }
    
    await prisma.candidate.update({
      where: { id },
      data: {
        isDeleted: true,
        deletedAt: new Date()
      }
    });

    // Invalidate cache before returning response to avoid race conditions
    await inv.candidate(orgId, id);

    // ── Respond IMMEDIATELY — client never waits for side effects ──
    res.json({ success: true, data: { id }, message: "Candidate deleted successfully" });

    // ── Side effects run AFTER response is on the wire ──
    setImmediate(async () => {
      try {
        await logAudit({
          actorUserId: req.user.id,
          action: "DELETE_CANDIDATE",
          entityType: "CANDIDATE",
          entityId: id,
          oldData: candidate,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        });
      } catch (auditErr) {
        console.error('[Candidates:Delete] Audit log failed (non-fatal):', auditErr.message);
      }
      sse.broadcastToOrg(orgId, 'CANDIDATE_DELETED', {
        candidateId: id,
        deletedBy: req.user.id,
        deletedByName: req.user.fullName || req.user.email,
      });
    });
  }),
);

// DELETE all candidates (SUPER_ADMIN only)
router.delete(
  "/all",
  requireRoles("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    // 1. Double confirmation check
    if (req.query.confirm !== "true") {
      return res.status(400).json({
        success: false,
        message: "Confirmation is required to delete all candidates. Please provide confirm=true parameter."
      });
    }

    // 2. Backup check and execution
    // Fetch all candidates to write to backup file
    const allCandidates = await prisma.candidate.findMany({
      where: { isDeleted: false }
    });

    if (allCandidates.length > 0) {
      const fs = require('fs');
      const path = require('path');
      const backupDir = path.join(__dirname, '../../../uploads/backups');
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }
      const backupPath = path.join(backupDir, `candidates_backup_${Date.now()}.json`);
      fs.writeFileSync(backupPath, JSON.stringify(allCandidates, null, 2));
    }

    // 3. Soft-delete instead of hard-delete
    const { count } = await prisma.candidate.updateMany({
      where: { isDeleted: false },
      data: {
        isDeleted: true,
        deletedAt: new Date()
      }
    });

    await logAudit({
      actorUserId: req.user.id,
      action: "DELETE_ALL_CANDIDATES",
      entityType: "CANDIDATE",
      oldData: { count },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    // Invalidate all cache
    const { invalidateAll } = require("../../utils/cache");
    invalidateAll();

    res.json({ success: true, message: `Soft-deleted ${count} candidates. A backup was created successfully.` });
  }),
);

// GET Export joining candidates as CSV
router.get(
  "/reports/joining",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    
    const candidates = await prisma.candidate.findMany({
      where: {
        isDeleted: false,
        doj: { not: null }
      },
      orderBy: { doj: 'asc' }
    });

    let items = candidates;

    if (from) items = items.filter(c => new Date(c.doj) >= new Date(from));
    if (to) items = items.filter(c => new Date(c.doj) <= new Date(to));

    items.sort((a, b) => new Date(a.doj) - new Date(b.doj));

    const csvRows = [["Full Name", "Email", "Phone", "DOJ"].join(",")];
    items.forEach(c => {
      csvRows.push([`"${c.fullName}"`, `"${c.email || ""}"`, `"${c.phone || ""}"`, `"${c.doj}"`].join(","));
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="joining_candidates.csv"');
    res.send(csvRows.join("\n"));
  })
);

// POST Transfer candidate to another job (creates application)
router.post(
  "/:id/transfer",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { toJobId } = req.body;
    if (!toJobId) throw new ApiError(400, "toJobId is required");

    const orgId = req.user.organizationId || "defaultOrg";

    const existingApp = await prisma.application.findFirst({
      where: { candidateId: id, jobId: toJobId, isDeleted: false }
    });
    if (existingApp) throw new ApiError(400, "Candidate is already applied to this job.");

    const application = await prisma.application.create({
      data: {
        candidateId: id,
        jobId: toJobId,
        status: "IN_PIPELINE",
        organizationId: orgId,
        isDeleted: false
      }
    });

    await inv.application(orgId, id);

    // Fetch job details
    const job = await prisma.job.findUnique({
      where: { id: toJobId }
    });
    const toJobTitle = job ? job.title : "New Job";

    sse.broadcastToOrg(orgId, 'APPLICATION_TRANSFERRED', {
      applicationId: application.id,
      candidateId: id,
      toJobId,
      toJobTitle,
      transferredBy: req.user.id,
      transferredByName: req.user.fullName || req.user.email,
    });

    res.json({ success: true, data: application });
  })
);

// GET /api/candidates/:id/resume-download (Proxy resume file direct download)
router.get(
  '/:id/resume-download',
  asyncHandler(async (req, res) => {
    const candidate = await prisma.candidate.findUnique({
      where: { id: req.params.id },
    });
    if (!candidate) throw new ApiError(404, 'Candidate not found');

    // SEC-005: Enforce organization scope — prevent cross-tenant IDOR on resume download
    const orgId = req.user.organizationId || 'defaultOrg';
    if (candidate.organizationId !== orgId) {
      throw new ApiError(403, 'You do not have access to this candidate\'s data');
    }

    const downloadUrl = candidate.resumeLinkDownload || candidate.resumeLinkOriginal;
    if (!downloadUrl) {
      throw new ApiError(404, 'No resume link on file for candidate');
    }

    const isAbsolute = downloadUrl.startsWith("http://") || downloadUrl.startsWith("https://");
    // Google Drive (and other cloud) links cannot be proxied reliably — open the source URL.
    const isGoogleDrive =
      candidate.resumeLinkProvider === "google_drive" ||
      (typeof downloadUrl === "string" && downloadUrl.includes("drive.google.com"));
    if (isAbsolute && (isGoogleDrive || candidate.resumeLinkProvider)) {
      const redirectTo = candidate.resumeLinkOriginal || downloadUrl;
      return res.redirect(302, redirectTo);
    }

    if (!isAbsolute) {
      // Local-disk paths are not available in production — Render wipes the ephemeral
      // filesystem on every redeploy. All pre-migration records have been cleared by
      // fix-broken-resume-records.js. Fail loudly with a user-facing message.
      throw new ApiError(404,
        "Resume link not available — this file was stored on the server's local disk before the " +
        "Aug 2026 storage migration and has since been permanently deleted by a server redeploy. " +
        "Please re-upload the resume for this candidate."
      );
    }

    // SEC-003: SSRF guard — reject internal/private network addresses before fetching
    if (!isSafeProxyUrl(downloadUrl)) {
      throw new ApiError(400, 'Resume link points to a disallowed address');
    }

    let upstream;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout
      upstream = await fetch(downloadUrl, {
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      // Re-check final URL after redirects to catch redirect-based SSRF
      if (upstream.url && !isSafeProxyUrl(upstream.url)) {
        throw new ApiError(400, 'Resume link redirected to a disallowed address');
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(502, `Could not retrieve resume from source link: ${err.message}`);
    }

    if (!upstream.ok) {
      throw new ApiError(502, `Could not retrieve resume from source link (HTTP ${upstream.status})`);
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const rawFilename = candidate.fullName ? candidate.fullName.trim() : 'candidate';
    const filename = `${rawFilename.replace(/[^\w-]/g, '_')}_resume`;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const { Readable } = require('stream');
    if (upstream.body) {
      if (typeof upstream.body.pipe === 'function') {
        upstream.body.pipe(res);
      } else {
        Readable.fromWeb(upstream.body).pipe(res);
      }
    } else {
      res.end();
    }
  })
);

// ── Contact Attempt Logging Endpoints ──
router.post(
  "/:candidateId/contact-attempts",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const { candidateId } = req.params;
    const { attemptType, photoUrl, note } = req.body;

    if (!attemptType || !['DIDNT_PICK_UP', 'MORNING_FOLLOW_UP'].includes(attemptType)) {
      throw new ApiError(400, "attemptType must be either 'DIDNT_PICK_UP' or 'MORNING_FOLLOW_UP'");
    }

    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { id: true },
    });
    if (!candidate) throw new ApiError(404, "Candidate not found");

    const attempt = await prisma.candidateContactAttempt.create({
      data: {
        candidateId,
        attemptType,
        photoUrl: photoUrl || null,
        note: note || null,
        loggedById: req.user.id,
        attemptedAt: new Date(),
      },
      include: {
        loggedBy: {
          select: { id: true, fullName: true, email: true },
        },
      },
    });

    res.status(201).json({
      success: true,
      data: attempt,
      message: `Contact attempt '${attemptType}' logged successfully.`,
    });
  })
);

router.get(
  "/:candidateId/contact-attempts",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const { candidateId } = req.params;

    const attempts = await prisma.candidateContactAttempt.findMany({
      where: { candidateId },
      orderBy: { attemptedAt: "desc" },
      include: {
        loggedBy: {
          select: { id: true, fullName: true, email: true },
        },
      },
    });

    res.json({
      success: true,
      data: attempts,
    });
  })
);

// ── Transfer Panelist Endpoint (Idempotent) ──
router.post(
  "/:candidateId/transfer-panelist",
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const { candidateId } = req.params;
    const { panelistId } = req.body;

    if (!panelistId) {
      throw new ApiError(400, "panelistId is required");
    }

    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
    });
    if (!candidate) throw new ApiError(404, "Candidate not found");

    const newPanelist = await prisma.user.findUnique({
      where: { id: panelistId },
      select: { id: true, fullName: true, email: true },
    });
    if (!newPanelist) throw new ApiError(404, "Panelist user not found");

    // Idempotency check: if candidate is already assigned to this panelist
    if (candidate.assignedRecruiterId === panelistId) {
      console.log("[TRANSFER PANELIST]", {
        candidateId,
        oldPanelistId: candidate.assignedRecruiterId,
        newPanelistId: panelistId,
        timestamp: new Date().toISOString(),
        outcome: "IDEMPOTENT_NOOP",
      });
      return res.json({
        success: true,
        message: "Panelist already assigned to candidate",
        data: candidate,
      });
    }

    const oldPanelistId = candidate.assignedRecruiterId;

    // Update candidate's assigned panelist/recruiter
    const updatedCandidate = await prisma.candidate.update({
      where: { id: candidateId },
      data: {
        assignedRecruiterId: panelistId,
        assignedRecruiterName: newPanelist.fullName,
      },
    });

    // Update active interviews for candidate
    const activeInterviews = await prisma.interview.findMany({
      where: { candidateId, status: { not: "CANCELLED" } },
    });

    for (const interview of activeInterviews) {
      const existingHistory = Array.isArray(interview.transferHistory)
        ? interview.transferHistory
        : [];
      const updatedHistory = [
        ...existingHistory,
        {
          transferredAt: new Date().toISOString(),
          transferredBy: req.user.id,
          fromPanelistId: oldPanelistId,
          toPanelistId: panelistId,
          toPanelistName: newPanelist.fullName,
        },
      ];

      await prisma.interview.update({
        where: { id: interview.id },
        data: {
          interviewerIds: [panelistId],
          interviewerNames: newPanelist.fullName,
          transferHistory: updatedHistory,
        },
      });
    }

    // Structured Audit & Server Console Log
    console.log("[TRANSFER PANELIST]", {
      candidateId,
      oldPanelistId,
      newPanelistId: panelistId,
      timestamp: new Date().toISOString(),
      outcome: "SUCCESS",
    });

    logAudit({
      actorUserId: req.user.id,
      action: "TRANSFER_PANELIST",
      entityType: "Candidate",
      entityId: candidateId,
      newData: {
        oldPanelistId,
        newPanelistId: panelistId,
      },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      orgId: req.user.organizationId || "defaultOrg",
    });

    // Broadcast SSE updates for instant tab sync
    sse.broadcast("CANDIDATE_UPDATED", { candidateId, panelistId, panelistName: newPanelist.fullName });
    sse.broadcast("INTERVIEW_PANELISTS_UPDATED", { candidateId, panelistId, panelistName: newPanelist.fullName });

    res.json({
      success: true,
      message: "Panelist transferred successfully",
      data: updatedCandidate,
    });
  })
);

/**
 * Resolves candidate record by phone number (normalized lookup).
 * Delegates to the shared candidateResolver lib — do not duplicate logic here.
 * @param {string} rawNumber
 * @param {string|null} organizationId
 * @returns {Promise<object|null>}
 */
// resolveCandidateByNumber is imported from ../../lib/candidateResolver above.

// GET /api/candidates/resolve-by-number?number=...
router.get(
  '/resolve-by-number',
  requireRoles("SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"),
  asyncHandler(async (req, res) => {
    const { number } = req.query;
    if (!number) {
      return res.json({ success: true, data: null });
    }

    const orgId = req.user.organizationId || "defaultOrg";
    const candidate = await resolveCandidateByNumber(number, orgId);

    res.json({
      success: true,
      data: candidate || null,
    });
  })
);

module.exports = router;
// Keep backward-compat export — processors should now import from lib/candidateResolver directly.
module.exports.resolveCandidateByNumber = resolveCandidateByNumber;


