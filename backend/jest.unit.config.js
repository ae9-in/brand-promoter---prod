/**
 * jest.unit.config.js — Fast local unit tests that require NO database.
 *
 * These tests mock all DB interactions and can run without NEON_TEST_DATABASE_URL.
 * Run with: npx jest --config jest.unit.config.js
 *
 * Tests covered:
 *  - sequentialRoundGating.test.js  (mocks prisma inline)
 *  - interviewTemplates.test.js     (pure logic, no DB)
 *  - bulkUploadPipeline.test.js     (pure lib functions)
 *  - datetime.test.js               (pure formatting utils)
 *  - sessionExpiryAndExcelViewSync.test.js (uses populateInterviewRelations with mocked l1Cache)
 *
 * NOTE: relationPopulator.test.js is intentionally excluded — it requires a real
 * DB connection to verify candidateId/jobId lookups via actual Prisma queries.
 */
'use strict';

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/tests/unit/sequentialRoundGating.test.js',
    '**/tests/unit/interviewTemplates.test.js',
    '**/tests/unit/bulkUploadPipeline.test.js',
    '**/tests/unit/datetime.test.js',
    '**/tests/unit/sessionExpiryAndExcelViewSync.test.js',
    '**/tests/unit/interviewStatusTransition.test.js',
    '**/tests/unit/followUpUploadPatch.test.js',
    '**/tests/unit/followUpOptimizer.test.js',
    '**/tests/unit/collegeDrivesUnifiedCandidate.test.js',
    '**/tests/unit/downloadStream.test.js',
    '**/tests/unit/driveDescription.test.js',
    '**/tests/unit/leadImportSchema.test.js',
    '**/tests/unit/passwordValidation.test.js',
    '**/tests/unit/productImport.test.js',
    '**/tests/unit/fileValidator.test.js',
  ],
  // NO globalSetup — these tests need no DB seeding
  testTimeout: 10000,
  verbose: true,
  maxWorkers: 1,
  forceExit: true,
};
