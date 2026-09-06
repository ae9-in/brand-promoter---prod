const express = require("express");
const XLSX = require("xlsx");
const prisma = require("../../config/db");
const { auth, requireRoles } = require("../../middleware/auth");
const { memoryUpload } = require("../../middleware/upload");
const { asyncHandler, ApiError } = require("../../utils/errors");
const { logAudit } = require("../../utils/audit");
const { broadcast } = require("../../utils/sse");

const router = express.Router();
router.use(auth);

const CAN_ACCESS = ["SUPER_ADMIN", "RECRUITER", "INTERVIEWER", "USER"];

function normalizeText(value) {
  return String(value || "").trim();
}

// --- COLLEGES ---

router.get(
  "/colleges",
  requireRoles(...CAN_ACCESS),
  asyncHandler(async (req, res) => {
    const colleges = await prisma.college.findMany({
      orderBy: { name: "asc" }
    });
    res.json({ success: true, data: colleges });
  }),
);

router.post(
  "/colleges",
  requireRoles(...CAN_ACCESS),
  asyncHandler(async (req, res) => {
    const { name, location, area, year, role, course } = req.body;
    const normalizedName = normalizeText(name);
    if (!normalizedName) throw new ApiError(400, "College name is required");

    const collegeData = {
      name: normalizedName,
      location: normalizeText(location) || null,
      area: normalizeText(area) || null,
      year: normalizeText(year) || null,
      role: normalizeText(role) || null,
      course: normalizeText(course) || null,
      createdById: req.user.id
    };

    const college = await prisma.college.create({
      data: collegeData
    });
    res.status(201).json({ success: true, data: college });
  }),
);

router.patch(
  "/colleges/:id",
  requireRoles(...CAN_ACCESS),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const updateData = { ...req.body };
    delete updateData.id;
    
    if (updateData.name !== undefined) {
      updateData.name = normalizeText(updateData.name);
    }
    
    await prisma.college.update({
      where: { id },
      data: updateData
    });
    res.json({ success: true });
  }),
);

router.delete(
  "/colleges/:id",
  requireRoles("SUPER_ADMIN", "ADMIN", "RECRUITER"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const college = await prisma.college.findUnique({
      where: { id }
    });
    if (!college) {
      throw new ApiError(404, "College not found");
    }

    // Find all drives associated with this college
    const drives = await prisma.collegeDrive.findMany({
      where: { collegeId: id },
      select: { id: true }
    });
    const driveIds = drives.map(d => d.id);

    await prisma.$transaction(async (tx) => {
      if (driveIds.length > 0) {
        await tx.collegeDriveCandidate.deleteMany({
          where: { driveId: { in: driveIds } }
        });
        await tx.collegeDrive.deleteMany({
          where: { collegeId: id }
        });
      }
      await tx.college.delete({
        where: { id }
      });
    });

    await logAudit({
      userId: req.user.id,
      action: "DELETE_COLLEGE",
      entity: "College",
      entityId: id,
      details: { collegeName: college.name, deletedDrivesCount: driveIds.length }
    });

    res.json({ success: true, message: `College "${college.name}" deleted successfully` });
  }),
);

const { validateDriveDescription } = require("../../config/driveConstants");

// --- DRIVES ---

router.get(
  "/drives",
  requireRoles(...CAN_ACCESS),
  asyncHandler(async (req, res) => {
    const { collegeId, search } = req.query;
    const where = { isDeleted: false };
    if (collegeId) where.collegeId = collegeId;
    if (search && String(search).trim()) {
      const q = String(search).trim();
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const drives = await prisma.collegeDrive.findMany({
      where,
      orderBy: { createdAt: "desc" }
    });
    res.json({ success: true, data: drives });
  }),
);

router.get(
  "/drives/:id",
  requireRoles(...CAN_ACCESS),
  asyncHandler(async (req, res) => {
    const drive = await prisma.collegeDrive.findFirst({
      where: { id: req.params.id, isDeleted: false }
    });
    if (!drive) throw new ApiError(404, "Drive not found");
    res.json({ success: true, data: drive });
  }),
);

router.post(
  "/drives",
  requireRoles(...CAN_ACCESS),
  asyncHandler(async (req, res) => {
    const { title, collegeId, dateFrom, dateTo, status, notes, description } = req.body;
    if (!title || !collegeId || !dateFrom) throw new ApiError(400, "Missing required drive fields");

    // Verify college exists
    const college = await prisma.college.findUnique({
      where: { id: collegeId }
    });
    if (!college) {
      throw new ApiError(404, "Selected college does not exist");
    }

    // Server-side validation of 200-word limit
    if (description) {
      const descValidation = validateDriveDescription(description);
      if (!descValidation.valid) {
        throw new ApiError(400, descValidation.error);
      }
    }

    let finalDateTo = dateTo || null;
    const finalStatus = status || "PLANNED";

    // Enforce consistency: COMPLETED drive cannot have open-ended/null end date
    if (finalStatus === "COMPLETED" && !finalDateTo) {
      finalDateTo = dateFrom;
    }

    if (finalDateTo && new Date(finalDateTo) < new Date(dateFrom)) {
      throw new ApiError(400, "End date cannot be before start date");
    }

    const driveData = {
      title: String(title).trim(),
      collegeId,
      dateFrom,
      dateTo: finalDateTo,
      status: finalStatus,
      description: description ? String(description).trim() : null,
      notes: notes || null,
      ownerId: req.user.id,
      organizationId: req.user.organizationId || "defaultOrg"
    };

    const drive = await prisma.collegeDrive.create({
      data: driveData
    });
    
    const orgId = req.user.organizationId || "defaultOrg";
    const inv = require("../../utils/cacheInvalidation");
    await inv.drive(orgId, drive.id);

    const sse = require("../../utils/sse");
    sse.broadcastToOrg(orgId, 'DRIVE_CREATED', {
      driveId: drive.id,
      collegeName: college.name,
      driveDate: driveData.dateFrom,
      city: driveData.notes || "",
      createdBy: req.user.id,
      createdByName: req.user.fullName || req.user.email,
    });

    res.status(201).json({ success: true, data: drive });
  }),
);

router.patch(
  "/drives/:id",
  requireRoles(...CAN_ACCESS),
  asyncHandler(async (req, res) => {
    const driveId = req.params.id;
    const existing = await prisma.collegeDrive.findUnique({
      where: { id: driveId }
    });
    if (!existing || existing.isDeleted) throw new ApiError(404, "Drive not found");

    const { title, dateFrom, dateTo, status, notes, description } = req.body;
    const updateData = {};

    if (title !== undefined) updateData.title = String(title).trim();
    if (dateFrom !== undefined) updateData.dateFrom = dateFrom;
    if (dateTo !== undefined) updateData.dateTo = dateTo || null;
    if (status !== undefined) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes || null;

    const effDateFrom = updateData.dateFrom !== undefined ? updateData.dateFrom : existing.dateFrom;
    let effDateTo = updateData.dateTo !== undefined ? updateData.dateTo : existing.dateTo;
    const effStatus = updateData.status !== undefined ? updateData.status : existing.status;

    // Enforce consistency: COMPLETED drive cannot have open-ended/null end date
    if (effStatus === "COMPLETED" && !effDateTo) {
      effDateTo = effDateFrom || new Date().toISOString().split('T')[0];
      updateData.dateTo = effDateTo;
    }

    if (effDateTo && effDateFrom && new Date(effDateTo) < new Date(effDateFrom)) {
      throw new ApiError(400, "End date cannot be before start date");
    }

    if (description !== undefined) {
      if (description) {
        const descValidation = validateDriveDescription(description);
        if (!descValidation.valid) {
          throw new ApiError(400, descValidation.error);
        }
        updateData.description = String(description).trim();
      } else {
        updateData.description = null;
      }
    }

    const updated = await prisma.collegeDrive.update({
      where: { id: driveId },
      data: updateData
    });

    const orgId = req.user.organizationId || "defaultOrg";
    const inv = require("../../utils/cacheInvalidation");
    await inv.drive(orgId, driveId);

    res.json({ success: true, data: updated });
  }),
);

// --- CANDIDATES & BULK ---

router.get(
  "/drives/:id/candidates",
  requireRoles(...CAN_ACCESS),
  asyncHandler(async (req, res) => {
    const driveCandidates = await prisma.collegeDriveCandidate.findMany({
      where: { driveId: req.params.id },
      orderBy: { createdAt: "desc" }
    });

    const candidateIds = driveCandidates.map(c => c.candidateId).filter(Boolean);
    const candidateMap = new Map();
    if (candidateIds.length > 0) {
      const candidates = await prisma.candidate.findMany({
        where: { id: { in: candidateIds } },
        select: { id: true, resumeFileId: true, resumeLinkOriginal: true, preferredRole: true, email: true, phone: true }
      });
      candidates.forEach(c => candidateMap.set(c.id, c));
    }

    const data = driveCandidates.map(dc => {
      const c = candidateMap.get(dc.candidateId);
      const hasResume = Boolean(c && (c.resumeFileId || c.resumeLinkOriginal));
      return {
        ...dc,
        preferredRole: c?.preferredRole || null,
        email: dc.email || c?.email || null,
        hasResume,
      };
    });

    res.json({ success: true, data });
  }),
);

router.post(
  "/drives/:id/candidates",
  requireRoles(...CAN_ACCESS),
  asyncHandler(async (req, res) => {
    const driveId = req.params.id;
    const { fullName, email, phone, course, location, preferredRole, company, source, college, resumeFileId, resumeLinkOriginal, resumeLinkDownload, resumeLinkProvider } = req.body;
    if (!fullName || !phone) throw new ApiError(400, "fullName and phone are required");

    const orgId = req.user.organizationId || "defaultOrg";
    const { normalizePhoneNumber } = require("../../lib/phoneNormalization");
    const phoneNormalized = normalizePhoneNumber(phone);

    // Check duplicate candidate by phone
    const existingCandidate = await prisma.candidate.findFirst({
      where: {
        organizationId: orgId,
        isDeleted: false,
        OR: [
          ...(phoneNormalized ? [{ phoneNormalized }, { phone: phone.trim() }] : [{ phone: phone.trim() }]),
        ]
      }
    });
    
    let candidateId;
    if (existingCandidate) {
      candidateId = existingCandidate.id;
      await prisma.candidate.update({
        where: { id: candidateId },
        data: {
          course: course || existingCandidate.course,
          location: location || existingCandidate.location,
          preferredRole: preferredRole || existingCandidate.preferredRole,
          company: company || existingCandidate.company,
          college: college || existingCandidate.college,
        }
      });
    } else {
      const candidate = await prisma.candidate.create({
        data: {
          fullName,
          email: email || "N/A",
          phone: phone.trim(),
          phoneNormalized,
          course: course || null,
          location: location || null,
          preferredRole: preferredRole || null,
          company: company || "Akshara Enterprises",
          college: college || null,
          source: source || "College Drive",
          resumeFileId: resumeFileId || null,
          resumeLinkOriginal: resumeLinkOriginal || null,
          resumeLinkDownload: resumeLinkDownload || null,
          resumeLinkProvider: resumeLinkProvider || null,
          organizationId: orgId
        }
      });
      candidateId = candidate.id;
    }

    const driveDup = await prisma.collegeDriveCandidate.findFirst({
      where: { driveId, candidateId }
    });
    if (driveDup) throw new ApiError(409, "Candidate already in this drive");

    await prisma.collegeDriveCandidate.create({
      data: {
        driveId,
        candidateId,
        fullName,
        email: email || null,
        phone,
        status: "ADDED"
      }
    });

    const inv = require("../../utils/cacheInvalidation");
    await inv.drive(orgId, driveId);
    await inv.candidateList(orgId);

    const sse = require("../../utils/sse");
    sse.broadcastToOrg(orgId, 'DRIVE_CANDIDATES_ADDED', {
      driveId,
      count: 1,
      collegeName: fullName,
      addedBy: req.user.id,
      addedByName: req.user.fullName || req.user.email,
    });
    sse.broadcastToOrg(orgId, 'CANDIDATE_CREATED', {
      candidateId,
      count: 1,
    });

    res.json({ success: true });
  }),
);

router.post(
  "/drives/:id/bulk-upload",
  requireRoles(...CAN_ACCESS),
  memoryUpload.single("file"),
  asyncHandler(async (req, res) => {
    const driveId = req.params.id;
    if (!req.file) throw new ApiError(400, "Excel file is required");

    let allRows = [];
    try {
      // SEC: Harden XLSX parsing — disable formulas (prevents ReDoS + prototype pollution)
      const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true, cellNF: false, cellText: false, cellFormula: false, bookVBA: false, bookFiles: false, defval: '' });
      for (const sheetName of workbook.SheetNames) {
        const worksheet = workbook.Sheets[sheetName];
        const sheetRows = XLSX.utils.sheet_to_json(worksheet, { defval: "", raw: false });
        
        sheetRows.forEach((row, idx) => {
          allRows.push({
            ...row,
            _sheetName: sheetName,
            _rowIndex: idx + 2
          });
        });
        console.log(`[BulkUpload] Parsed ${sheetRows.length} rows from sheet "${sheetName}"`);
      }
    } catch (err) {
      console.error("[BulkUpload] XLSX Parse Error:", err);
      throw new ApiError(400, "Failed to parse Excel file. Please ensure it is a valid .xlsx or .csv file.");
    }

    const results = { inserted: 0, skipped: 0, errors: [] };
    const orgId = req.user.organizationId || "defaultOrg";

    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i];
      const sheetInfo = `[Sheet: ${row._sheetName}, Row ${row._rowIndex}]`;

      const getValue = (patterns) => {
        const key = Object.keys(row).find(k => 
          patterns.some(p => k.trim().toLowerCase() === p.toLowerCase())
        );
        return key ? String(row[key] || "").trim() : "";
      };

      const fullName = getValue(["fullName", "name", "Name", "NAME", "Full Name", "Student Name"]);
      const phone = getValue(["phone", "Phone", "PHONE", "contact", "Contact", "CONTACT", "mobile", "Mobile", "phone number", "PhoneNumber"]);
      const email = getValue(["email", "Email", "EMAIL", "mail id", "MailID"]).toLowerCase();

      // Skip completely empty rows
      if (!fullName && !phone && !email) continue;

      if (!fullName || !phone) {
        results.skipped++;
        results.errors.push(`${sheetInfo}: Missing fullName or phone`);
        continue;
      }

      try {
        const existingCandidate = await prisma.candidate.findFirst({
          where: { phone, isDeleted: false }
        });
        
        let candidateId;
        if (existingCandidate) {
          candidateId = existingCandidate.id;
        } else {
          const candidate = await prisma.candidate.create({
            data: {
              fullName,
              email: email || "N/A",
              phone,
              source: "College Drive Bulk",
              organizationId: orgId
            }
          });
          candidateId = candidate.id;
        }

        const driveDup = await prisma.collegeDriveCandidate.findFirst({
          where: { driveId, candidateId }
        });

        if (!driveDup) {
          await prisma.collegeDriveCandidate.create({
            data: {
              driveId,
              candidateId,
              fullName,
              email: email || null,
              phone,
              status: "ADDED"
            }
          });
          results.inserted++;
        } else {
          results.skipped++;
          results.errors.push(`${sheetInfo}: Candidate already in drive`);
        }
      } catch (e) {
        results.skipped++;
        results.errors.push(`${sheetInfo}: Error - ${e.message}`);
      }
    }

    if (results.inserted > 0) {
      const inv = require("../../utils/cacheInvalidation");
      await inv.drive(orgId, driveId);
      await inv.candidateList(orgId);

      const sse = require("../../utils/sse");
      sse.broadcastToOrg(orgId, 'DRIVE_CANDIDATES_ADDED', {
        driveId,
        count: results.inserted,
        collegeName: "Bulk Upload",
        addedBy: req.user.id,
        addedByName: req.user.fullName || req.user.email,
      });
    }
    res.json({ success: true, data: results });
  }),
);

// --- RECRUITERS, JOBS & STATUS ---

router.post("/drives/:id/recruiters", requireRoles(...CAN_ACCESS), asyncHandler(async (req, res) => {
  const { recruiterIds } = req.body;
  const recruiters = recruiterIds.map(uid => ({ userId: uid, assignedAt: new Date().toISOString() }));
  
  await prisma.collegeDrive.update({
    where: { id: req.params.id },
    data: { recruiters }
  });
  res.json({ success: true });
}));

router.post("/drives/:id/jobs", requireRoles(...CAN_ACCESS), asyncHandler(async (req, res) => {
  const { jobIds } = req.body;
  const drive = await prisma.collegeDrive.findUnique({
    where: { id: req.params.id }
  });
  if (!drive) throw new ApiError(404, "Drive not found");
  
  let existing = [];
  try {
    existing = typeof drive.linkedJobs === 'string' ? JSON.parse(drive.linkedJobs) : drive.linkedJobs;
  } catch (_) {}
  if (!Array.isArray(existing)) existing = [];
  
  for (const jid of jobIds) {
    if (!existing.some(l => l.jobId === jid)) {
      const job = await prisma.job.findUnique({
        where: { id: jid }
      });
      if (job) {
        existing.push({ jobId: jid, job, linkedAt: new Date().toISOString() });
      }
    }
  }
  
  await prisma.collegeDrive.update({
    where: { id: req.params.id },
    data: { linkedJobs: existing }
  });
  res.json({ success: true });
}));

router.delete("/drives/:id/jobs/:jobId", requireRoles(...CAN_ACCESS), asyncHandler(async (req, res) => {
  const drive = await prisma.collegeDrive.findUnique({
    where: { id: req.params.id }
  });
  if (!drive) throw new ApiError(404, "Drive not found");
  
  let existing = [];
  try {
    existing = typeof drive.linkedJobs === 'string' ? JSON.parse(drive.linkedJobs) : drive.linkedJobs;
  } catch (_) {}
  if (!Array.isArray(existing)) existing = [];
  
  const filtered = existing.filter(l => l.jobId !== req.params.jobId);
  await prisma.collegeDrive.update({
    where: { id: req.params.id },
    data: { linkedJobs: filtered }
  });
  res.json({ success: true });
}));

router.patch("/drives/:id/candidates/:candidateId/status", requireRoles(...CAN_ACCESS), asyncHandler(async (req, res) => {
  const driveCandidate = await prisma.collegeDriveCandidate.findFirst({
    where: {
      driveId: req.params.id,
      candidateId: req.params.candidateId
    }
  });

  if (driveCandidate) {
    await prisma.collegeDriveCandidate.update({
      where: { id: driveCandidate.id },
      data: { status: req.body.status }
    });
    
    const orgId = req.user.organizationId || "defaultOrg";
    const inv = require("../../utils/cacheInvalidation");
    await inv.drive(orgId, req.params.id);

    const sse = require("../../utils/sse");
    sse.broadcastToOrg(orgId, 'DRIVE_STATUS_CHANGED', {
      driveId: req.params.id,
      status: req.body.status,
      collegeName: driveCandidate.fullName,
      changedBy: req.user.id,
      changedByName: req.user.fullName || req.user.email,
    });
  }
  res.json({ success: true });
}));

router.get("/drives/:id/timeline", requireRoles(...CAN_ACCESS), asyncHandler(async (req, res) => {
  res.json({ success: true, data: [] });
}));

module.exports = router;
