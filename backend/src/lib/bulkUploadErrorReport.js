'use strict';

const fs = require('fs');
const path = require('path');
const { BULK_UPLOAD_LIMITS } = require('../config/bulkUploadLimits');

// Ensure reports directory exists inside uploads/
const REPORTS_DIR = path.join(__dirname, '..', '..', 'uploads', 'reports');
if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

// Memory map of active report rows: jobId → { rows: Array, filePath: string }
// Rows are accumulated in memory (max 500 rows × ~300 bytes = ~150KB per job — safe)
const jobReports = new Map();

// Purge timer handles: jobId → setTimeout handle
const purgeTimers = new Map();

/**
 * Purges report files older than REPORT_TTL_MS on startup.
 * Called once at module load time — cleans up orphans from previous crashes.
 */
function purgeStaleReportsOnStartup() {
  try {
    const now = Date.now();
    const files = fs.readdirSync(REPORTS_DIR);
    for (const file of files) {
      if (!file.startsWith('bulk_upload_report_') || !file.endsWith('.xlsx')) continue;
      const filePath = path.join(REPORTS_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > BULK_UPLOAD_LIMITS.REPORT_TTL_MS) {
          fs.unlinkSync(filePath);
          console.log(`[BulkUploadReport] Purged stale report: ${file}`);
        }
      } catch (_) {}
    }
    // Also purge legacy .csv reports
    for (const file of files) {
      if (!file.startsWith('bulk_upload_report_') || !file.endsWith('.csv')) continue;
      const filePath = path.join(REPORTS_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > BULK_UPLOAD_LIMITS.REPORT_TTL_MS) {
          fs.unlinkSync(filePath);
          console.log(`[BulkUploadReport] Purged stale legacy CSV report: ${file}`);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

// Run startup purge
purgeStaleReportsOnStartup();

/**
 * Schedules a report file for deletion after REPORT_TTL_MS (24 hours).
 * @param {string} jobId
 */
function scheduleReportPurge(jobId) {
  const filePath = path.join(REPORTS_DIR, `bulk_upload_report_${jobId}.xlsx`);

  const existing = purgeTimers.get(jobId);
  if (existing) clearTimeout(existing);

  const handle = setTimeout(() => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[BulkUploadReport] TTL expired — purged report for job ${jobId}`);
      }
    } catch (_) {}
    jobReports.delete(jobId);
    purgeTimers.delete(jobId);
  }, BULK_UPLOAD_LIMITS.REPORT_TTL_MS);

  if (handle.unref) handle.unref();
  purgeTimers.set(jobId, handle);
}

/**
 * Initializes a new XLSX error report accumulator for a bulk upload job.
 * @param {string} jobId
 */
function initErrorReport(jobId) {
  const filePath = path.join(REPORTS_DIR, `bulk_upload_report_${jobId}.xlsx`);
  jobReports.set(jobId, {
    filePath,
    rows: [],
  });
  return filePath;
}

/**
 * SEC-010: Formula Injection / CSV Injection Sanitizer.
 * Prefixes cells that begin with formula trigger characters (=, +, -, @, TAB, CR) with a
 * single quote. This is the universally accepted defence for spreadsheet formula injection
 * (aka CSV injection). Applied to all user-supplied string values written to report cells.
 */
function csvSafeString(val) {
  const s = String(val ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/**
 * Appends a row failure, duplicate warning, or soft warning to the job's report accumulator.
 * Rows are written to XLSX only on finalize (via finalizeErrorReport).
 *
 * @param {string} jobId
 * @param {number|string} rowNumber
 * @param {string} reason
 * @param {string|boolean} [severity='error']
 * @param {string} [errorType=null]
 */
function appendFailedRow(jobId, rowNumber, reason, severity = 'error', errorType = null) {
  let report = jobReports.get(jobId);
  if (!report) {
    // Lazily init if not already done (guard against out-of-order calls)
    initErrorReport(jobId);
    report = jobReports.get(jobId);
  }

  let sevText = 'error';
  let typeText = errorType || 'DATA_ERROR';

  if (severity === 'SYSTEM_ERROR') {
    sevText = 'error';
    typeText = 'SYSTEM_ERROR';
  } else if (severity === 'DATA_ERROR') {
    sevText = 'error';
    typeText = 'DATA_ERROR';
  } else if (severity === true || severity === 'warning') {
    sevText = 'warning';
    typeText = 'N/A';
  } else if (severity === 'duplicate') {
    sevText = 'duplicate';
    typeText = 'N/A';
  }

  report.rows.push({
    row_number: rowNumber,
    severity: sevText,
    error_type: typeText,
    reason: csvSafeString(reason || ''),
  });
}

/**
 * Finalizes the report: writes all accumulated rows to a real XLSX file and returns the download URL.
 * Also schedules the report for deletion after REPORT_TTL_MS.
 *
 * @param {string} jobId
 * @param {string} [flowType='candidates']
 * @returns {string|null} Relative URL for download
 */
async function finalizeErrorReport(jobId, flowType = 'candidates') {
  const report = jobReports.get(jobId);
  if (!report) {
    return null;
  }

  const { filePath, rows } = report;

  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Import Report');

    // Header row
    ws.columns = [
      { header: 'Row Number', key: 'row_number', width: 14 },
      { header: 'Severity',   key: 'severity',   width: 12 },
      { header: 'Error Type', key: 'error_type', width: 16 },
      { header: 'Reason',     key: 'reason',     width: 80 },
    ];

    // Style header
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9D9D9' },
    };

    // Add data rows with conditional row colours (capped at 1000 rows to protect memory)
    const MAX_REPORT_ROWS = 1000;
    const exportRows = rows.slice(0, MAX_REPORT_ROWS);

    for (const row of exportRows) {
      const dataRow = ws.addRow(row);

      // Colour coding: errors = light red, duplicates = light yellow, warnings = light blue
      let rowColor = null;
      if (row.severity === 'error') {
        rowColor = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD7D7' } };
      } else if (row.severity === 'duplicate') {
        rowColor = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFACC' } };
      } else if (row.severity === 'warning') {
        rowColor = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD7F0FF' } };
      }

      if (rowColor) {
        dataRow.eachCell(cell => {
          cell.fill = rowColor;
        });
      }
    }

    if (rows.length > MAX_REPORT_ROWS) {
      const overflowRow = ws.addRow({
        row_number: 'N/A',
        severity: 'warning',
        error_type: 'TRUNCATED',
        reason: `Note: Error report truncated at ${MAX_REPORT_ROWS} rows. Total ${rows.length - MAX_REPORT_ROWS} additional errors omitted to prevent memory overload.`,
      });
      overflowRow.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFACC' } };
      });
    }

    // Freeze header row
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    // Enable word wrap on Reason column
    ws.getColumn('reason').alignment = { wrapText: true, vertical: 'top' };

    const arrayBuffer = await wb.xlsx.writeBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(filePath, buffer);

    console.log(`[BulkUploadReport] Wrote XLSX report for job ${jobId}: ${rows.length} rows, ${buffer.length} bytes`);
  } catch (err) {
    console.error(`[BulkUploadReport] Failed to write XLSX for job ${jobId}:`, err.message);
    // Fallback: write minimal CSV so downloads don't 404
    const csv = 'row_number,severity,error_type,reason\n' +
      report.rows.map(r => `${r.row_number},"${r.severity}","${r.error_type}","${String(r.reason).replace(/"/g, '""')}"`).join('\n');
    const csvPath = filePath.replace('.xlsx', '.csv');
    try { fs.writeFileSync(csvPath, csv, 'utf8'); } catch (_) {}
    // Return null to signal failure — caller should handle gracefully
    return null;
  }

  // Schedule 24h purge
  scheduleReportPurge(jobId);

  const cleanFlow = String(flowType || '').toLowerCase();
  if (cleanFlow.includes('feedback')) {
    return `/api/interview-feedback/bulk-upload/${jobId}/report`;
  } else if (cleanFlow.includes('interview')) {
    return `/api/interviews/bulk-upload/${jobId}/report`;
  } else if (cleanFlow.includes('joined')) {
    return `/api/candidates/bulk-upload/joined/${jobId}/report`;
  } else if (cleanFlow.includes('offer')) {
    return `/api/candidates/bulk-upload/offer-letter/${jobId}/report`;
  }
  return `/api/candidates/bulk-upload/${jobId}/report`;
}

/**
 * Returns the absolute path to the XLSX report file for serving.
 * Falls back to CSV if only a legacy CSV exists (transition period).
 * @param {string} jobId
 * @returns {string|null}
 */
function getErrorReportPath(jobId) {
  const xlsxPath = path.join(REPORTS_DIR, `bulk_upload_report_${jobId}.xlsx`);
  if (fs.existsSync(xlsxPath)) {
    return xlsxPath;
  }
  // Fallback: legacy CSV (written before the XLSX upgrade or on write failure)
  const csvPath = path.join(REPORTS_DIR, `bulk_upload_report_${jobId}.csv`);
  if (fs.existsSync(csvPath)) {
    return csvPath;
  }
  return null;
}

/**
 * Returns the MIME type for the error report file.
 * Used by route handlers to set the correct Content-Type header.
 * @param {string} filePath
 * @returns {string}
 */
function getReportContentType(filePath) {
  if (!filePath) return 'application/octet-stream';
  if (filePath.endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  return 'text/csv; charset=utf-8';
}

module.exports = {
  initErrorReport,
  appendFailedRow,
  finalizeErrorReport,
  getErrorReportPath,
  getReportContentType,
  scheduleReportPurge,
};
