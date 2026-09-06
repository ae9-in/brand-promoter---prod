'use strict';

/**
 * Definition of the All Candidates Bulk Import Schema (Strict: Name, Role, Email, Phone, Resume Link required)
 */
const ALL_CANDIDATES_IMPORT_SCHEMA = [
  { key: 'candidateId', label: 'candidate id', required: false },
  { key: 'name',       label: 'Name',         required: true },
  { key: 'role',       label: 'Role',         required: true },
  { key: 'email',      label: 'e-mail',       required: true },
  { key: 'phone',      label: 'phone number', required: true },
  { key: 'resumeLink', label: 'resume link',  required: true },
  { key: 'college',    label: 'college',      required: false },
  { key: 'location',   label: 'location',     required: false },
  { key: 'course',     label: 'course',       required: false },
  { key: 'source',     label: 'source',       required: false },
  { key: 'company',    label: 'company',      required: false },
];

/**
 * Definition of the College Drive Candidates Bulk Import Schema
 * Mandatory: Name, phone number only.
 * Optional: Role, e-mail (contact info), resume link, and all demographic fields.
 * This relaxed schema reflects that college drive candidates are often collected
 * on-site with incomplete information and resume links are gathered later.
 */
const COLLEGE_DRIVE_IMPORT_SCHEMA = [
  { key: 'candidateId', label: 'candidate id', required: false },
  { key: 'name',       label: 'Name',         required: true },
  { key: 'role',       label: 'Role',         required: false },
  { key: 'email',      label: 'e-mail',       required: false },
  { key: 'phone',      label: 'phone number', required: true },
  { key: 'resumeLink', label: 'resume link',  required: false },
  { key: 'college',    label: 'college',      required: false },
  { key: 'location',   label: 'location',     required: false },
  { key: 'course',     label: 'course',       required: false },
  { key: 'source',     label: 'source',       required: false },
  { key: 'company',    label: 'company',      required: false },
];

const CANDIDATE_IMPORT_SCHEMA = ALL_CANDIDATES_IMPORT_SCHEMA;

module.exports = {
  ALL_CANDIDATES_IMPORT_SCHEMA,
  COLLEGE_DRIVE_IMPORT_SCHEMA,
  CANDIDATE_IMPORT_SCHEMA,
};

