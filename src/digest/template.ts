/**
 * Thin re-export of the shared digest template so existing callers can keep
 * importing from their local path. Real implementation lives in
 * shared/mail/digest-template.ts.
 */
module.exports = require('../../shared/mail/digest-template');
