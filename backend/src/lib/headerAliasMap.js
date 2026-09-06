'use strict';

/**
 * Normalizes incoming CSV/XLSX header text to canonical field keys.
 * Matches case-insensitively, strips UTF-8 BOM if present, and trims whitespace.
 * Also strips trailing asterisks (e.g. "Name *" or "phone number*") so recruiters
 * removing or leaving asterisks does not break mapping.
 */
const HEADER_ALIASES = {
  'name': 'name',
  'full name': 'name',
  'candidate name': 'name',

  'role': 'role',
  'position': 'role',
  'job role': 'role',
  'preferred role': 'role',
  'preferred_role': 'role',
  'preferredrole': 'role',
  'preferred job role': 'role',

  'e-mail': 'email',
  'email': 'email',
  'email address': 'email',

  'phone number': 'phone',
  'phone': 'phone',
  'mobile': 'phone',
  'mobile number': 'phone',
  'contact number': 'phone',

  'resume link': 'resumeLink',
  'resume': 'resumeLink',
  'resume url': 'resumeLink',
  'cv link': 'resumeLink',
  'resume lonk': 'resumeLink', // tolerated typo

  'college': 'college',
  'university': 'college',

  'location': 'location',
  'city': 'location',

  'course': 'course',
  'degree': 'course',

  'source': 'source',
  'lead source': 'source',
  'referral': 'source',

  'company': 'company',
  'current company': 'company',
  'employer': 'company',

  // External / sheet candidate id (uniqueness key — NOT the same as name)
  'candidate id': 'candidateId',
  'candidateid': 'candidateId',
  'candidate_id': 'candidateId',
  'external id': 'candidateId',
  'externalid': 'candidateId',
  'applicant id': 'candidateId',
  'application id': 'candidateId',

  // Round / Round Number Aliases
  'round': 'round',
  'round number': 'round',
  'round_number': 'round',
  'roundnumber': 'round',
  'interview round': 'round',

  // Meeting Mode Aliases
  'meeting mode': 'mode',
  'meeting_mode': 'mode',
  'interview mode': 'mode',
  'interview_mode': 'mode',
  'mode': 'mode',

  // Start Date / Time Aliases
  'start date': 'startDateTime',
  'start date & time': 'startDateTime',
  'start date and time': 'startDateTime',
  'start_date_time': 'startDateTime',
  'startdatetime': 'startDateTime',
  'scheduled start': 'startDateTime',
  'scheduled_start': 'startDateTime',
  'scheduledstart': 'startDateTime',
  'start': 'startDateTime',

  // Interviewer / Panelist Aliases
  'interviewers': 'interviewers',
  'interviewer': 'interviewers',
  'panelists': 'interviewers',
  'panelist': 'interviewers',
  'panelist name': 'interviewers',
  'panelist_name': 'interviewers',

  // Meeting Link / Zoho Link Aliases
  'meeting link': 'meetingLink',
  'meeting_link': 'meetingLink',
  'meetinglink': 'meetingLink',
  'link': 'meetingLink',
  'zoho link': 'zohoLink',
  'zoho_link': 'zohoLink',
  'zoholink': 'zohoLink',
  'zoho meeting link': 'zohoLink',
  'zoho meeting': 'zohoLink',
  'zoho_meeting_link': 'zohoLink',

  // Joining Date / DOJ Aliases (used by Joined + Offer Letter paths)
  'joining date': 'joiningDate',
  'date of joining': 'joiningDate',
  'doj': 'joiningDate',
  'joining_date': 'joiningDate',
  'join date': 'joiningDate',

  // Offer Date Aliases
  'offer date': 'offerDate',
  'offer_date': 'offerDate',
  'offerdate': 'offerDate',
  'offer sent date': 'offerDate',
  'date of offer': 'offerDate',

  // Offer Decision Aliases
  'offer decision': 'offerDecision',
  'offer_decision': 'offerDecision',
  'offerdecision': 'offerDecision',
  'decision': 'offerDecision',

  // Candidate Status Aliases (for direct status overrides in specialized paths)
  'status': 'status',
  'candidate status': 'status',
};

function resolveHeader(rawHeader) {
  if (rawHeader === undefined || rawHeader === null) return null;
  // Clean BOM, remove trailing asterisks and surrounding space
  const cleaned = String(rawHeader)
    .trim()
    .replace(/^\uFEFF/, '')
    .replace(/\s*\*+$/, '')
    .trim();
  const key = cleaned.toLowerCase();
  if (HEADER_ALIASES[key]) return HEADER_ALIASES[key];

  // Robust prefix-based fallback matching for common truncations (e.g. "Phone Nu", "Meeting Mod", "Interviewe")
  if (key.startsWith('phone') || key.startsWith('mobile') || key.startsWith('contact')) return 'phone';
  if (key.startsWith('meeting mod') || key.startsWith('interview mod') || key === 'mode' || key.startsWith('mod')) return 'mode';
  if (key.startsWith('interviewer') || key.startsWith('interviewe') || key.startsWith('panelist')) return 'interviewers';
  if (key.startsWith('job role') || key === 'role' || key.startsWith('position')) return 'role';
  // Do NOT map bare "candidate*" → name (that stole "candidate id")
  if (key === 'name' || key.startsWith('name ') || key.startsWith('full name') || key.startsWith('candidate name')) return 'name';
  if (key.startsWith('candidate id') || key.startsWith('external id') || key.startsWith('applicant id')) return 'candidateId';
  if (key.startsWith('email') || key.startsWith('e-mail')) return 'email';
  if (key.startsWith('resume') || key.startsWith('cv')) return 'resumeLink';
  if (key.startsWith('start date') || key.startsWith('scheduled start') || key.startsWith('start')) return 'startDateTime';
  if (key.startsWith('zoho')) return 'zohoLink';
  if (key.startsWith('meeting link') || key.startsWith('meeting_link') || key === 'link') return 'meetingLink';

  return null;
}

module.exports = {
  HEADER_ALIASES,
  resolveHeader,
};
