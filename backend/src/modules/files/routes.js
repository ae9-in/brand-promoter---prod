const express = require("express");
const { upload } = require("../../middleware/upload");
const { auth } = require("../../middleware/auth");
const { asyncHandler, ApiError } = require("../../utils/errors");
const { validateFile } = require("../../utils/fileValidator");
const prisma = require("../../config/db");
const { makeStorageKey, streamDbFile } = require("../../utils/dbStorage");

const router = express.Router();
router.use(auth);

// POST /api/files/profile-photo — Upload a profile photo, stored in DB
router.post("/profile-photo", upload.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(400, "No file uploaded");

  validateFile(req.file, 'profilePhoto');

  // Store file binary directly in DB
  const tempMeta = await prisma.fileMeta.create({
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
    where: { id: tempMeta.id },
    data: { storageKey: makeStorageKey(tempMeta.id) }
  });

  const storageKey = makeStorageKey(tempMeta.id);
  res.json({ success: true, url: storageKey, fileId: tempMeta.id });
}));

// GET /api/files/:id — Serve a file by FileMeta ID (for profile photos etc.)
router.get("/:id", asyncHandler(async (req, res) => {
  const fileMeta = await prisma.fileMeta.findUnique({
    where: { id: req.params.id },
  });

  if (!fileMeta) throw new ApiError(404, "File not found");

  // SEC-004: Enforce organization scope — prevent cross-tenant IDOR on file download.
  // Resolve the uploader's org and compare against the requester's org.
  const requesterOrgId = req.user.organizationId || 'defaultOrg';
  if (fileMeta.uploadedById) {
    const uploader = await prisma.user.findUnique({
      where: { id: fileMeta.uploadedById },
      select: { organizationId: true },
    });
    if (!uploader || uploader.organizationId !== requesterOrgId) {
      throw new ApiError(403, "You do not have access to this file");
    }
  }
  // If uploadedById is null (legacy/system files), allow access only to SUPER_ADMIN
  else if (req.user.role !== 'SUPER_ADMIN') {
    throw new ApiError(403, "You do not have access to this file");
  }

  if (!fileMeta.fileData || fileMeta.fileData.length === 0) {
    throw new ApiError(404, "File data not found in database.");
  }

  res.setHeader("Content-Type", fileMeta.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(fileMeta.originalName || 'file')}"`);
  streamDbFile(fileMeta.fileData, res);
}));

module.exports = router;
