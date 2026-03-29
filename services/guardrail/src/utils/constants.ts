export const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  UNPROCESSABLE_ENTITY: 422,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export const ERROR_MESSAGES = {
  INVALID_REQUEST: 'Invalid request format',
  MISSING_PROVIDER_ID: 'Provider ID is required',
  VALIDATION_FAILED: 'Request validation failed',
} as const;
